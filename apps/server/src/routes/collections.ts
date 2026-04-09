import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { scopeToUser } from "../middleware/user-scope.js";
import { getPresignedDownloadUrl } from "../services/storage.js";
import { notFound, badRequest } from "../lib/errors.js";

const createCollectionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullish(),
  color: z.string().max(50).nullish(),
});

const updateCollectionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullish(),
  color: z.string().max(50).nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

const addBookSchema = z.object({
  bookId: z.string().uuid(),
});

type Variables = { userId: string };

const collectionsRouter = new Hono<{ Variables: Variables }>();

const effectiveTitle = sql<string | null>`coalesce(${schema.books.titleOverride}, ${schema.files.title})`;
const effectiveAuthor = sql<string | null>`coalesce(${schema.books.authorOverride}, ${schema.files.author})`;

async function assertUserOwnsCollection(
  collectionId: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(
      and(eq(schema.collections.id, collectionId), scopeToUser.collections(userId)),
    )
    .limit(1);
  if (!row) throw notFound("Collection not found");
}

async function assertUserOwnsBook(
  bookId: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)))
    .limit(1);
  if (!row) throw notFound("Book not found");
}

// GET /collections
collectionsRouter.get("/", async (c) => {
  const userId = c.get("userId");
  const result = await db
    .select()
    .from(schema.collections)
    .where(scopeToUser.collections(userId))
    .orderBy(schema.collections.sortOrder);
  return c.json({ collections: result });
});

// POST /collections
collectionsRouter.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const parsed = createCollectionSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid input");

  const [collection] = await db
    .insert(schema.collections)
    .values({
      userId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      color: parsed.data.color ?? null,
    })
    .returning();

  return c.json({ collection }, 201);
});

// PATCH /collections/:id
collectionsRouter.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateCollectionSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid input");

  const [updated] = await db
    .update(schema.collections)
    .set({
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.color !== undefined && { color: parsed.data.color }),
      ...(parsed.data.sortOrder !== undefined && { sortOrder: parsed.data.sortOrder }),
    })
    .where(and(eq(schema.collections.id, id), scopeToUser.collections(userId)))
    .returning();

  if (!updated) throw notFound("Collection not found");
  return c.json({ collection: updated });
});

// DELETE /collections/:id
// Ownership check runs BEFORE the cascade delete so a stray call with an
// id from someone else can't drop their bookCollections rows.
collectionsRouter.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  await assertUserOwnsCollection(id, userId);

  // Drop join rows first, then the collection itself.
  await db
    .delete(schema.bookCollections)
    .where(eq(schema.bookCollections.collectionId, id));
  await db
    .delete(schema.collections)
    .where(and(eq(schema.collections.id, id), scopeToUser.collections(userId)));

  return c.json({ deleted: true });
});

// POST /collections/:id/books — add a book to a collection
collectionsRouter.post("/:id/books", async (c) => {
  const userId = c.get("userId");
  const collectionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = addBookSchema.safeParse(body);
  if (!parsed.success) throw badRequest("Valid bookId (UUID) required");

  await assertUserOwnsCollection(collectionId, userId);
  await assertUserOwnsBook(parsed.data.bookId, userId);

  const [entry] = await db
    .insert(schema.bookCollections)
    .values({ bookId: parsed.data.bookId, collectionId })
    .onConflictDoNothing()
    .returning();

  return c.json({ added: !!entry }, 201);
});

// DELETE /collections/:id/books/:bookId — remove a book from a collection.
// Previously this was completely unauthenticated: any bearer token could
// rip any book from any collection. Now both sides must belong to the caller.
collectionsRouter.delete("/:id/books/:bookId", async (c) => {
  const userId = c.get("userId");
  const collectionId = c.req.param("id");
  const bookId = c.req.param("bookId");

  await assertUserOwnsCollection(collectionId, userId);
  await assertUserOwnsBook(bookId, userId);

  await db
    .delete(schema.bookCollections)
    .where(
      and(
        eq(schema.bookCollections.collectionId, collectionId),
        eq(schema.bookCollections.bookId, bookId),
      ),
    );

  return c.json({ removed: true });
});

// GET /collections/:id/books — list books in a collection.
// Ownership-gated on the collection itself (previously anyone could view
// any collection's book list as long as they queried the right UUID).
collectionsRouter.get("/:id/books", async (c) => {
  const userId = c.get("userId");
  const collectionId = c.req.param("id");

  await assertUserOwnsCollection(collectionId, userId);

  const rows = await db
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
      addedAt: schema.bookCollections.addedAt,
    })
    .from(schema.bookCollections)
    .innerJoin(schema.books, eq(schema.bookCollections.bookId, schema.books.id))
    .innerJoin(schema.files, eq(schema.books.fileId, schema.files.id))
    .where(
      and(
        eq(schema.bookCollections.collectionId, collectionId),
        eq(schema.books.userId, userId),
      ),
    )
    .orderBy(schema.bookCollections.addedAt);

  const books = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      coverUrl: row.coverKey ? await getPresignedDownloadUrl(row.coverKey) : null,
    })),
  );

  return c.json({ books });
});

export default collectionsRouter;
