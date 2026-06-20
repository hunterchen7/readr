import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { scopeToUser } from "../middleware/user-scope.js";
import {
  createBookmarkSchema,
  createHighlightSchema,
  createNoteSchema,
  updateAnnotationSchema,
} from "@readr/shared";
import { notFound, forbidden } from "../lib/errors.js";

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

// GET /api/books/:id/annotations
app.get("/books/:id/annotations", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const type = c.req.query("type");

  const [bookmarksResult, highlightsResult, notesResult] = await Promise.all([
    !type || type === "bookmark"
      ? db
          .select()
          .from(schema.bookmarks)
          .where(
            and(
              eq(schema.bookmarks.bookId, bookId),
              scopeToUser.bookmarks(userId),
              isNull(schema.bookmarks.deletedAt),
            ),
          )
      : [],
    !type || type === "highlight"
      ? db
          .select()
          .from(schema.highlights)
          .where(
            and(
              eq(schema.highlights.bookId, bookId),
              scopeToUser.highlights(userId),
              isNull(schema.highlights.deletedAt),
            ),
          )
      : [],
    !type || type === "note"
      ? db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.bookId, bookId),
              scopeToUser.notes(userId),
              isNull(schema.notes.deletedAt),
            ),
          )
      : [],
  ]);

  return c.json({
    bookmarks: bookmarksResult,
    highlights: highlightsResult,
    notes: notesResult,
  });
});

// POST /api/books/:id/bookmarks
app.post("/books/:id/bookmarks", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  await assertBookOwnership(bookId, userId);
  const body = createBookmarkSchema.parse(await c.req.json());

  const [bookmark] = await db
    .insert(schema.bookmarks)
    .values({ bookId, userId, ...body })
    .returning();

  return c.json({ bookmark }, 201);
});

// POST /api/books/:id/highlights
app.post("/books/:id/highlights", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  await assertBookOwnership(bookId, userId);
  const body = createHighlightSchema.parse(await c.req.json());

  const [highlight] = await db
    .insert(schema.highlights)
    .values({ bookId, userId, ...body })
    .returning();

  return c.json({ highlight }, 201);
});

// POST /api/books/:id/notes
app.post("/books/:id/notes", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  await assertBookOwnership(bookId, userId);
  const body = createNoteSchema.parse(await c.req.json());

  const [note] = await db
    .insert(schema.notes)
    .values({ bookId, userId, ...body })
    .returning();

  return c.json({ note }, 201);
});

// PATCH /api/annotations/:id
app.patch("/annotations/:id", async (c) => {
  const userId = c.get("userId");
  const annotationId = c.req.param("id");
  const body = updateAnnotationSchema.parse(await c.req.json());

  // Try each annotation table (bookmark, highlight, note)
  // Bookmarks
  if (body.label !== undefined) {
    const [bookmark] = await db
      .update(schema.bookmarks)
      .set({ label: body.label })
      .where(
        and(eq(schema.bookmarks.id, annotationId), scopeToUser.bookmarks(userId)),
      )
      .returning();
    if (bookmark) return c.json({ annotation: bookmark });
  }

  // Highlights
  if (body.color !== undefined || body.note !== undefined) {
    const update: Record<string, unknown> = {};
    if (body.color) update.color = body.color;
    if (body.note !== undefined) update.note = body.note;

    const [highlight] = await db
      .update(schema.highlights)
      .set(update)
      .where(
        and(eq(schema.highlights.id, annotationId), scopeToUser.highlights(userId)),
      )
      .returning();
    if (highlight) return c.json({ annotation: highlight });
  }

  // Notes
  const noteUpdate: Record<string, unknown> = { updatedAt: new Date() };
  if (body.textContent !== undefined) noteUpdate.textContent = body.textContent;
  if (body.strokes) noteUpdate.strokes = body.strokes;
  if (body.penConfig) noteUpdate.penConfig = body.penConfig;
  if (body.canvasImage !== undefined) noteUpdate.canvasImage = body.canvasImage;

  const [note] = await db
    .update(schema.notes)
    .set(noteUpdate)
    .where(and(eq(schema.notes.id, annotationId), scopeToUser.notes(userId)))
    .returning();
  if (note) return c.json({ annotation: note });

  throw notFound("Annotation not found");
});

// DELETE /api/annotations/:id (soft delete)
app.delete("/annotations/:id", async (c) => {
  const userId = c.get("userId");
  const annotationId = c.req.param("id");
  const now = new Date();

  // Try soft-deleting from each annotation table
  const results = await Promise.all([
    db
      .update(schema.bookmarks)
      .set({ deletedAt: now })
      .where(
        and(eq(schema.bookmarks.id, annotationId), scopeToUser.bookmarks(userId)),
      )
      .returning(),
    db
      .update(schema.highlights)
      .set({ deletedAt: now })
      .where(
        and(eq(schema.highlights.id, annotationId), scopeToUser.highlights(userId)),
      )
      .returning(),
    db
      .update(schema.notes)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.notes.id, annotationId), scopeToUser.notes(userId)))
      .returning(),
  ]);

  const deleted = results.some((r) => r.length > 0);
  if (!deleted) throw notFound("Annotation not found");

  return c.json({ success: true });
});

export default app;
