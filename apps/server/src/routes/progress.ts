import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { scopeToUser } from "../middleware/user-scope.js";
import { upsertProgressSchema } from "@readr/shared";

type Variables = { userId: string };

const app = new Hono<{ Variables: Variables }>();

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
