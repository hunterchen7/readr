import { Hono } from "hono";
import { eq, and, desc, asc, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { scopeToUser } from "../middleware/user-scope.js";
import {
  listBooksQuerySchema,
  updateBookMetadataSchema,
} from "@readr/shared";
import {
  uploadFile,
  getPresignedDownloadUrl,
  deleteFile,
} from "../services/storage.js";
import {
  computeSha256,
  getFileExtension,
  getContentType,
  extractMetadata,
} from "../services/book-processor.js";
import { env } from "../lib/env.js";
import { notFound, badRequest, payloadTooLarge, conflict } from "../lib/errors.js";

type Variables = { userId: string };

const app = new Hono<{ Variables: Variables }>();

// GET /api/books — List user's books
app.get("/", async (c) => {
  const userId = c.get("userId");
  const query = listBooksQuerySchema.parse(c.req.query());

  let qb = db
    .select({
      id: schema.books.id,
      userId: schema.books.userId,
      fileId: schema.books.fileId,
      title: schema.books.title,
      author: schema.books.author,
      language: schema.books.language,
      totalChapters: schema.books.totalChapters,
      metadata: schema.books.metadata,
      uploadedAt: schema.books.uploadedAt,
      format: schema.files.format,
      fileSize: schema.files.size,
      coverKey: schema.files.coverKey,
    })
    .from(schema.books)
    .innerJoin(schema.files, eq(schema.books.fileId, schema.files.id))
    .where(scopeToUser.books(userId))
    .$dynamic();

  if (query.search) {
    qb = qb.where(
      and(
        scopeToUser.books(userId),
        or(
          ilike(schema.books.title, `%${query.search}%`),
          ilike(schema.books.author, `%${query.search}%`),
        ),
      ),
    );
  }

  switch (query.sort) {
    case "title":
      qb = qb.orderBy(asc(schema.books.title));
      break;
    case "author":
      qb = qb.orderBy(asc(schema.books.author));
      break;
    case "recent":
    default:
      qb = qb.orderBy(desc(schema.books.uploadedAt));
      break;
  }

  const rows = await qb;

  const books = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      coverUrl: row.coverKey
        ? await getPresignedDownloadUrl(row.coverKey)
        : null,
    })),
  );

  return c.json({ books });
});

// POST /api/books — Upload new book
app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    throw badRequest("No file provided");
  }

  const format = getFileExtension(file.name);
  if (format !== "epub" && format !== "pdf") {
    throw badRequest("Only .epub and .pdf files are supported");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sizeMb = buffer.length / (1024 * 1024);

  if (sizeMb > env.MAX_UPLOAD_SIZE_MB) {
    throw payloadTooLarge(
      `File exceeds max upload size of ${env.MAX_UPLOAD_SIZE_MB}MB`,
    );
  }

  // Check storage quota
  const [user] = await db
    .select({
      storageQuotaMb: schema.users.storageQuotaMb,
      storageUsedMb: schema.users.storageUsedMb,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));

  if (
    user &&
    (user.storageUsedMb ?? 0) + sizeMb > (user.storageQuotaMb ?? 1024)
  ) {
    throw payloadTooLarge("Storage quota exceeded");
  }

  // Content-addressable dedup
  const sha256 = computeSha256(buffer);
  const s3Key = `files/${sha256}.${format}`;

  const [existingFile] = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.sha256, sha256));

  let fileId: string;

  if (existingFile) {
    // Check if this user already has this book
    const [existingBook] = await db
      .select()
      .from(schema.books)
      .where(
        and(
          eq(schema.books.userId, userId),
          eq(schema.books.fileId, existingFile.id),
        ),
      );

    if (existingBook) {
      throw conflict("You already have this book in your library");
    }

    // Increment refCount
    await db
      .update(schema.files)
      .set({ refCount: sql`${schema.files.refCount} + 1` })
      .where(eq(schema.files.id, existingFile.id));

    fileId = existingFile.id;
  } else {
    // Upload to S3
    await uploadFile(s3Key, buffer, getContentType(format));

    const [newFile] = await db
      .insert(schema.files)
      .values({
        sha256,
        s3Key,
        size: buffer.length,
        format,
      })
      .returning();

    fileId = newFile.id;
  }

  // Extract metadata
  const metadata = await extractMetadata(buffer, format, file.name);

  // Create book record
  const [book] = await db
    .insert(schema.books)
    .values({
      userId,
      fileId,
      title: metadata.title,
      author: metadata.author,
      language: metadata.language,
      totalChapters: metadata.totalChapters,
    })
    .returning();

  // Update storage used
  await db
    .update(schema.users)
    .set({
      storageUsedMb: sql`${schema.users.storageUsedMb} + ${Math.ceil(sizeMb)}`,
    })
    .where(eq(schema.users.id, userId));

  return c.json({ book }, 201);
});

// GET /api/books/:id — Get book with download URL
app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");

  const [row] = await db
    .select({
      id: schema.books.id,
      userId: schema.books.userId,
      fileId: schema.books.fileId,
      title: schema.books.title,
      author: schema.books.author,
      language: schema.books.language,
      totalChapters: schema.books.totalChapters,
      metadata: schema.books.metadata,
      uploadedAt: schema.books.uploadedAt,
      s3Key: schema.files.s3Key,
      coverKey: schema.files.coverKey,
      format: schema.files.format,
      fileSize: schema.files.size,
    })
    .from(schema.books)
    .innerJoin(schema.files, eq(schema.books.fileId, schema.files.id))
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)));

  if (!row) throw notFound("Book not found");

  const [downloadUrl, coverUrl] = await Promise.all([
    getPresignedDownloadUrl(row.s3Key),
    row.coverKey ? getPresignedDownloadUrl(row.coverKey) : null,
  ]);

  return c.json({
    book: {
      id: row.id,
      userId: row.userId,
      fileId: row.fileId,
      title: row.title,
      author: row.author,
      language: row.language,
      totalChapters: row.totalChapters,
      metadata: row.metadata,
      uploadedAt: row.uploadedAt,
      format: row.format,
      fileSize: row.fileSize,
      downloadUrl,
      coverUrl,
    },
  });
});

// PATCH /api/books/:id/metadata — Update book metadata
app.patch("/:id/metadata", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const body = updateBookMetadataSchema.parse(await c.req.json());

  const [book] = await db
    .update(schema.books)
    .set(body)
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)))
    .returning();

  if (!book) throw notFound("Book not found");

  return c.json({ book });
});

// DELETE /api/books/:id — Delete book
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");

  const [book] = await db
    .select({
      id: schema.books.id,
      fileId: schema.books.fileId,
    })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)));

  if (!book) throw notFound("Book not found");

  // Get file info for storage accounting
  const [file] = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.id, book.fileId));

  // Delete the book record (cascades to progress, annotations)
  await db.delete(schema.books).where(eq(schema.books.id, bookId));

  // Decrement file refCount
  if (file) {
    const newRefCount = (file.refCount ?? 1) - 1;

    if (newRefCount <= 0) {
      // Delete from S3 and DB
      await Promise.all([
        deleteFile(file.s3Key),
        file.coverKey ? deleteFile(file.coverKey) : Promise.resolve(),
        db.delete(schema.files).where(eq(schema.files.id, file.id)),
      ]);
    } else {
      await db
        .update(schema.files)
        .set({ refCount: newRefCount })
        .where(eq(schema.files.id, file.id));
    }

    // Update storage used
    const fileSizeMb = Math.ceil(file.size / (1024 * 1024));
    await db
      .update(schema.users)
      .set({
        storageUsedMb: sql`GREATEST(${schema.users.storageUsedMb} - ${fileSizeMb}, 0)`,
      })
      .where(eq(schema.users.id, userId));
  }

  return c.json({ success: true });
});

export default app;
