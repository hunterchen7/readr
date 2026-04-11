import { Hono } from "hono";
import { eq, and, desc, asc, ilike, or, sql, count } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { scopeToUser } from "../middleware/user-scope.js";
import { listBooksQuerySchema, updateBookMetadataSchema } from "@readr/shared";
import {
  uploadFile,
  getPresignedDownloadUrl,
  deleteFile,
} from "../services/storage.js";
import {
  computeSha256,
  computeMd5,
  getFileExtension,
  getContentType,
  extractMetadata,
} from "../services/book-processor.js";
import { env } from "../lib/env.js";
import { notFound, badRequest, payloadTooLarge, conflict } from "../lib/errors.js";

type Variables = { userId: string };

const app = new Hono<{ Variables: Variables }>();

/** Effective title = per-user override, else shared files.title. */
const effectiveTitle = sql<string | null>`coalesce(${schema.books.titleOverride}, ${schema.files.title})`;
const effectiveAuthor = sql<string | null>`coalesce(${schema.books.authorOverride}, ${schema.files.author})`;

// GET /api/books — list the user's library
app.get("/", async (c) => {
  const userId = c.get("userId");
  const query = listBooksQuerySchema.parse(c.req.query());

  const conditions = [scopeToUser.books(userId)];
  if (query.search) {
    const pattern = `%${query.search}%`;
    conditions.push(
      or(
        ilike(schema.files.title, pattern),
        ilike(schema.files.author, pattern),
        ilike(schema.books.titleOverride, pattern),
        ilike(schema.books.authorOverride, pattern),
      )!,
    );
  }
  if (query.format) {
    conditions.push(eq(schema.files.format, query.format));
  }

  // Subquery for latest progress percentage per book (most recent, not max)
  const progressSq = db
    .select({
      bookId: schema.readingProgress.bookId,
      percentage: sql<number>`(
        SELECT (rp2.position->>'percentage')::int
        FROM reading_progress rp2
        WHERE rp2.book_id = ${schema.readingProgress.bookId}
          AND rp2.user_id = ${userId}
        ORDER BY rp2.updated_at DESC
        LIMIT 1
      )`.as("progress_pct"),
    })
    .from(schema.readingProgress)
    .where(eq(schema.readingProgress.userId, userId))
    .groupBy(schema.readingProgress.bookId)
    .as("prog");

  let qb = db
    .select({
      id: schema.books.id,
      userId: schema.books.userId,
      fileId: schema.books.fileId,
      title: effectiveTitle,
      author: effectiveAuthor,
      language: schema.files.language,
      totalChapters: schema.files.totalChapters,
      metadata: schema.files.metadata,
      uploadedAt: schema.books.uploadedAt,
      format: schema.files.format,
      fileSize: schema.files.size,
      coverKey: schema.files.coverKey,
      progressPct: sql<number | null>`${progressSq.percentage}`,
    })
    .from(schema.books)
    .innerJoin(schema.files, eq(schema.books.fileId, schema.files.id))
    .leftJoin(progressSq, eq(progressSq.bookId, schema.books.id))
    .where(and(...conditions))
    .$dynamic();

  switch (query.sort) {
    case "title":
      qb = qb.orderBy(asc(effectiveTitle));
      break;
    case "author":
      qb = qb.orderBy(asc(effectiveAuthor));
      break;
    case "lastRead": {
      // Sort by latest reading_progress.updated_at for this user.
      // Books with no progress yet fall to the end.
      const lastRead = db
        .select({
          bookId: schema.readingProgress.bookId,
          latest: sql`max(${schema.readingProgress.updatedAt})`.as("latest"),
        })
        .from(schema.readingProgress)
        .where(eq(schema.readingProgress.userId, userId))
        .groupBy(schema.readingProgress.bookId)
        .as("lp");
      qb = qb
        .leftJoin(lastRead, eq(lastRead.bookId, schema.books.id))
        .orderBy(sql`${lastRead.latest} desc nulls last`);
      break;
    }
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

// POST /api/books — upload a new book (content-addressable, dedup across users)
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

  // Storage quota
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

  // Content-addressable dedup. Every upload of the same bytes collapses
  // onto a single files row; metadata is extracted ONCE on first upload.
  // MD5 is stored alongside for cross-reference with external services
  // (Anna's Archive etc.) that key on MD5.
  const sha256 = computeSha256(buffer);
  const md5 = computeMd5(buffer);

  const [existingFile] = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.sha256, sha256));

  let fileId: string;

  if (existingFile) {
    // Refuse if this user already has the book in their library.
    const [existingBook] = await db
      .select({ id: schema.books.id })
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

    // Opportunistically backfill md5 for files that pre-date this column.
    if (!existingFile.md5) {
      await db
        .update(schema.files)
        .set({ md5 })
        .where(eq(schema.files.id, existingFile.id));
    }

    fileId = existingFile.id;
  } else {
    // First time we see this file anywhere — upload to S3, extract
    // metadata, persist. S3 writes happen BEFORE the DB insert so a
    // mid-flight failure never leaves the DB pointing at a missing key.
    const s3Key = `files/${sha256}.${format}`;
    let coverKey: string | null = null;
    const metadata = await extractMetadata(buffer, format, file.name);

    try {
      await uploadFile(s3Key, buffer, getContentType(format));
      if (metadata.cover) {
        coverKey = `covers/${sha256}.jpg`;
        await uploadFile(coverKey, metadata.cover, "image/jpeg");
      }

      const [newFile] = await db
        .insert(schema.files)
        .values({
          sha256,
          md5,
          s3Key,
          coverKey,
          size: buffer.length,
          format,
          title: metadata.title,
          author: metadata.author,
          language: metadata.language,
          totalChapters: metadata.totalChapters,
        })
        .returning();

      fileId = newFile.id;
    } catch (err) {
      // Compensating cleanup: delete whatever we already wrote to S3.
      await Promise.allSettled([
        deleteFile(s3Key),
        coverKey ? deleteFile(coverKey) : Promise.resolve(),
      ]);
      throw err;
    }
  }

  // Wrap the multi-table mutation in a transaction so a crash between
  // inserting the books row and updating the user quota can't leave
  // the database in an inconsistent state.
  const insertedId = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.books)
      .values({ userId, fileId })
      .returning({ id: schema.books.id });

    await tx
      .update(schema.users)
      .set({
        storageUsedMb: sql`${schema.users.storageUsedMb} + ${Math.ceil(sizeMb)}`,
      })
      .where(eq(schema.users.id, userId));

    return inserted.id;
  });

  const full = await fetchBookById(insertedId, userId);
  if (!full) throw notFound("Book not found after insert");
  return c.json({ book: full }, 201);
});

/**
 * Shared helper that returns the full joined Book shape used by
 * GET /api/books/:id. Both POST and PATCH call this so they return a
 * consistent object.
 */
async function fetchBookById(bookId: string, userId: string) {
  const [row] = await db
    .select({
      id: schema.books.id,
      userId: schema.books.userId,
      fileId: schema.books.fileId,
      title: effectiveTitle,
      author: effectiveAuthor,
      language: schema.files.language,
      totalChapters: schema.files.totalChapters,
      metadata: schema.files.metadata,
      uploadedAt: schema.books.uploadedAt,
      s3Key: schema.files.s3Key,
      coverKey: schema.files.coverKey,
      format: schema.files.format,
      fileSize: schema.files.size,
    })
    .from(schema.books)
    .innerJoin(schema.files, eq(schema.books.fileId, schema.files.id))
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)));

  if (!row) return null;

  const [downloadUrl, coverUrl] = await Promise.all([
    getPresignedDownloadUrl(row.s3Key),
    row.coverKey ? getPresignedDownloadUrl(row.coverKey) : null,
  ]);

  return {
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
  };
}

// GET /api/books/:id — book detail + signed download/cover URLs
app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const book = await fetchBookById(bookId, userId);
  if (!book) throw notFound("Book not found");
  return c.json({ book });
});

// PATCH /api/books/:id/metadata — per-user rename (stored as titleOverride).
// Returns the full joined Book shape so callers can update state without
// a follow-up GET.
app.patch("/:id/metadata", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const body = updateBookMetadataSchema.parse(await c.req.json());

  const [updated] = await db
    .update(schema.books)
    .set({
      titleOverride: body.title ?? undefined,
      authorOverride: body.author ?? undefined,
    })
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)))
    .returning({ id: schema.books.id });

  if (!updated) throw notFound("Book not found");
  const book = await fetchBookById(updated.id, userId);
  if (!book) throw notFound("Book not found");
  return c.json({ book });
});

// DELETE /api/books/:id — remove from user's library; drop file if last ref.
// Uses a transaction with row-level locking on the files row to prevent
// two concurrent deletes from both seeing refCount = 1 and racing to
// delete the S3 object.
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");

  const [book] = await db
    .select({ id: schema.books.id, fileId: schema.books.fileId })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)));

  if (!book) throw notFound("Book not found");

  // Transaction: delete books row, compute true ref count, conditionally
  // delete files row, update storage quota — all atomically.
  const orphanedFile = await db.transaction(async (tx) => {
    await tx.delete(schema.books).where(eq(schema.books.id, bookId));

    // Lock the files row to prevent concurrent deletes from racing.
    const [file] = await tx
      .select()
      .from(schema.files)
      .where(eq(schema.files.id, book.fileId))
      .for("update");

    if (!file) return null;

    // Compute the ACTUAL reference count from the books table rather
    // than trusting the manually-maintained refCount column.
    const [{ refs }] = await tx
      .select({ refs: count() })
      .from(schema.books)
      .where(eq(schema.books.fileId, file.id));

    const fileSizeMb = Math.ceil(file.size / (1024 * 1024));
    await tx
      .update(schema.users)
      .set({
        storageUsedMb: sql`GREATEST(${schema.users.storageUsedMb} - ${fileSizeMb}, 0)`,
      })
      .where(eq(schema.users.id, userId));

    if (Number(refs) === 0) {
      await tx.delete(schema.files).where(eq(schema.files.id, file.id));
      return file; // caller deletes S3 objects outside the transaction
    }

    // Keep refCount in sync for fast reads (but the source of truth
    // is now the COUNT query above).
    await tx
      .update(schema.files)
      .set({ refCount: Number(refs) })
      .where(eq(schema.files.id, file.id));

    return null;
  });

  // S3 deletes happen AFTER the transaction commits so we don't hold
  // the lock while waiting on network I/O.
  if (orphanedFile) {
    await Promise.allSettled([
      deleteFile(orphanedFile.s3Key),
      orphanedFile.coverKey ? deleteFile(orphanedFile.coverKey) : Promise.resolve(),
    ]);
  }

  return c.json({ success: true });
});

export default app;
