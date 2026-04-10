import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { scopeToUser } from "../middleware/user-scope.js";
import { upsertProgressSchema } from "@readr/shared";
import { forbidden } from "../lib/errors.js";

type Variables = { userId: string };

const app = new Hono<{ Variables: Variables }>();

/** Verify the authenticated user owns the book, or throw 403. */
async function assertBookOwnership(bookId: string, userId: string) {
  const [row] = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)));
  if (!row) throw forbidden("Book does not belong to user");
}

// GET /api/books/:id/progress (below) — but first, a batch endpoint
// mounted via index.ts at /api/progress/all to avoid /:id conflict.

// GET /api/books/:id/progress
app.get("/:id/progress", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");

  const positions = await db
    .select()
    .from(schema.readingProgress)
    .where(
      and(
        eq(schema.readingProgress.bookId, bookId),
        scopeToUser.readingProgress(userId),
      ),
    );

  return c.json({ positions });
});

// PUT /api/books/:id/progress
app.put("/:id/progress", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  await assertBookOwnership(bookId, userId);
  const body = upsertProgressSchema.parse(await c.req.json());

  const [progress] = await db
    .insert(schema.readingProgress)
    .values({
      bookId,
      userId,
      deviceId: body.deviceId,
      position: body.position,
    })
    .onConflictDoUpdate({
      target: [
        schema.readingProgress.bookId,
        schema.readingProgress.userId,
        schema.readingProgress.deviceId,
      ],
      set: {
        position: body.position,
        updatedAt: new Date(),
      },
    })
    .returning();

  return c.json({ progress });
});

export default app;
