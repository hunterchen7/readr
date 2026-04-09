import { Hono } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, isNull, sql } from "drizzle-orm";
import { scopeToUser } from "../middleware/user-scope.js";
import { notFound } from "../lib/errors.js";

type Variables = { userId: string };

const exportRouter = new Hono<{ Variables: Variables }>();

// GET /export/annotations/:bookId — export as Markdown
exportRouter.get("/export/annotations/:bookId", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("bookId");
  const format = c.req.query("format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    return c.json({ error: "format must be 'markdown' or 'json'" }, 400);
  }

  // Verify book belongs to user. Title/author come from the joined files
  // row (shared across users) with an optional per-user override.
  const [book] = await db
    .select({
      id: schema.books.id,
      title: sql<string | null>`coalesce(${schema.books.titleOverride}, ${schema.files.title})`,
      author: sql<string | null>`coalesce(${schema.books.authorOverride}, ${schema.files.author})`,
    })
    .from(schema.books)
    .innerJoin(schema.files, eq(schema.books.fileId, schema.files.id))
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)))
    .limit(1);

  if (!book) {
    throw notFound("Book not found");
  }

  // Fetch all annotations
  const [bookmarksResult, highlightsResult, notesResult] = await Promise.all([
    db
      .select()
      .from(schema.bookmarks)
      .where(
        and(
          eq(schema.bookmarks.bookId, bookId),
          scopeToUser.bookmarks(userId),
          isNull(schema.bookmarks.deletedAt),
        ),
      )
      .orderBy(schema.bookmarks.createdAt),
    db
      .select()
      .from(schema.highlights)
      .where(
        and(
          eq(schema.highlights.bookId, bookId),
          scopeToUser.highlights(userId),
          isNull(schema.highlights.deletedAt),
        ),
      )
      .orderBy(schema.highlights.createdAt),
    db
      .select()
      .from(schema.notes)
      .where(
        and(
          eq(schema.notes.bookId, bookId),
          scopeToUser.notes(userId),
          isNull(schema.notes.deletedAt),
        ),
      )
      .orderBy(schema.notes.createdAt),
  ]);

  if (format === "json") {
    return c.json({
      book: { title: book.title, author: book.author },
      bookmarks: bookmarksResult,
      highlights: highlightsResult,
      notes: notesResult,
    });
  }

  // Default: Markdown
  const lines: string[] = [];
  lines.push(`# ${book.title ?? "Untitled"}`);
  if (book.author) lines.push(`**Author:** ${book.author}`);
  lines.push("");
  lines.push(`*Exported on ${new Date().toLocaleDateString()}*`);
  lines.push("");

  if (highlightsResult.length > 0) {
    lines.push("## Highlights");
    lines.push("");
    for (const h of highlightsResult) {
      lines.push(`> ${h.textContent ?? "(no text)"}`);
      if (h.note) lines.push(`> **Note:** ${h.note}`);
      lines.push(`> — *${h.color}*`);
      lines.push("");
    }
  }

  if (bookmarksResult.length > 0) {
    lines.push("## Bookmarks");
    lines.push("");
    for (const b of bookmarksResult) {
      const pos = b.position as { percentage?: number };
      lines.push(`- ${b.label ?? "Bookmark"} (${pos.percentage ?? 0}%)`);
    }
    lines.push("");
  }

  if (notesResult.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const n of notesResult) {
      const pos = n.position as { percentage?: number };
      lines.push(`### Note at ${pos.percentage ?? 0}%`);
      if (n.textContent) lines.push(n.textContent);
      if (n.noteType === "handwritten") {
        lines.push("*(Handwritten note — view in app)*");
      }
      lines.push("");
    }
  }

  const markdown = lines.join("\n");

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${(book.title ?? "annotations").replace(/"/g, "")}.md"`,
    },
  });
});

export default exportRouter;
