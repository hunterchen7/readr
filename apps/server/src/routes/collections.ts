import { Hono } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and } from "drizzle-orm";

type Variables = { userId: string };

const collectionsRouter = new Hono<{ Variables: Variables }>();

// GET /collections
collectionsRouter.get("/", async (c) => {
  const userId = c.get("userId");

  const result = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.userId, userId))
    .orderBy(schema.collections.sortOrder);

  return c.json({ collections: result });
});

// POST /collections
collectionsRouter.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json() as { name: string; description?: string; color?: string };

  const [collection] = await db
    .insert(schema.collections)
    .values({
      userId,
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? null,
    })
    .returning();

  return c.json({ collection }, 201);
});

// PATCH /collections/:id
collectionsRouter.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json() as { name?: string; description?: string; color?: string; sortOrder?: number };

  const [updated] = await db
    .update(schema.collections)
    .set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.color !== undefined && { color: body.color }),
      ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
    })
    .where(and(eq(schema.collections.id, id), eq(schema.collections.userId, userId)))
    .returning();

  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ collection: updated });
});

// DELETE /collections/:id
collectionsRouter.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  await db
    .delete(schema.bookCollections)
    .where(eq(schema.bookCollections.collectionId, id));

  const deleted = await db
    .delete(schema.collections)
    .where(and(eq(schema.collections.id, id), eq(schema.collections.userId, userId)))
    .returning();

  if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ deleted: true });
});

// POST /collections/:id/books — add a book to a collection
collectionsRouter.post("/:id/books", async (c) => {
  const userId = c.get("userId");
  const collectionId = c.req.param("id");
  const body = await c.req.json() as { bookId: string };

  // Verify collection belongs to user
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(and(eq(schema.collections.id, collectionId), eq(schema.collections.userId, userId)))
    .limit(1);

  if (!collection) return c.json({ error: "Collection not found" }, 404);

  const [entry] = await db
    .insert(schema.bookCollections)
    .values({ bookId: body.bookId, collectionId })
    .onConflictDoNothing()
    .returning();

  return c.json({ added: !!entry }, 201);
});

// DELETE /collections/:id/books/:bookId — remove a book from a collection
collectionsRouter.delete("/:id/books/:bookId", async (c) => {
  const collectionId = c.req.param("id");
  const bookId = c.req.param("bookId");

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

// GET /collections/:id/books — list books in a collection
collectionsRouter.get("/:id/books", async (c) => {
  const userId = c.get("userId");
  const collectionId = c.req.param("id");

  const result = await db
    .select({
      book: schema.books,
      addedAt: schema.bookCollections.addedAt,
    })
    .from(schema.bookCollections)
    .innerJoin(schema.books, eq(schema.bookCollections.bookId, schema.books.id))
    .where(
      and(
        eq(schema.bookCollections.collectionId, collectionId),
        eq(schema.books.userId, userId),
      ),
    )
    .orderBy(schema.bookCollections.addedAt);

  return c.json({ books: result.map((r) => r.book) });
});

export default collectionsRouter;
