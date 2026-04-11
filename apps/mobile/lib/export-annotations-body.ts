/**
 * Pure serialization helpers for the annotations export. Extracted
 * from export-annotations.ts so both the native (Sharing + FS) and
 * web (Blob download) variants can share the markdown/JSON builders
 * without duplicating the schema.
 */
import type { Highlight, Note, Bookmark } from "@readr/shared";

export type ExportFormat = "markdown" | "json";

export interface ExportInput {
  bookTitle: string;
  bookAuthor: string | null;
  highlights: Highlight[];
  notes: Note[];
  bookmarks: Bookmark[];
  format: ExportFormat;
}

export function sanitizeFileBase(bookTitle: string): string {
  return (
    bookTitle
      .trim()
      .replace(/[^\w\s.-]+/g, "")
      .slice(0, 80) || "annotations"
  );
}

export function mimeForFormat(format: ExportFormat): string {
  return format === "json" ? "application/json" : "text/markdown";
}

export function extForFormat(format: ExportFormat): string {
  return format === "json" ? "json" : "md";
}

export function buildExportBody(input: ExportInput): string {
  return input.format === "json"
    ? JSON.stringify(toJson(input), null, 2)
    : toMarkdown(input);
}

function toMarkdown(input: ExportInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.bookTitle}`);
  if (input.bookAuthor) lines.push(`**Author:** ${input.bookAuthor}`);
  lines.push("");
  lines.push(`*Exported ${new Date().toLocaleString()}*`);
  lines.push("");

  if (input.highlights.length > 0) {
    lines.push(`## Highlights (${input.highlights.length})`);
    lines.push("");
    for (const h of input.highlights) {
      lines.push(`> ${h.textContent ?? "(no text)"}`);
      if (h.note) lines.push(`> **Note:** ${h.note}`);
      lines.push(`> — *${h.color}*`);
      lines.push("");
    }
  }

  if (input.notes.length > 0) {
    lines.push(`## Notes (${input.notes.length})`);
    lines.push("");
    for (const n of input.notes) {
      const pos = n.position as { percentage?: number };
      lines.push(`### ${n.noteType === "typed" ? "Note" : "Handwritten"} @ ${pos.percentage ?? 0}%`);
      if (n.textContent) lines.push(n.textContent);
      if (n.noteType === "handwritten") {
        lines.push("*(handwritten — view in Readr)*");
      }
      lines.push("");
    }
  }

  if (input.bookmarks.length > 0) {
    lines.push(`## Bookmarks (${input.bookmarks.length})`);
    lines.push("");
    for (const b of input.bookmarks) {
      const pos = b.position as { percentage?: number };
      lines.push(`- ${b.label ?? "Bookmark"} (${pos.percentage ?? 0}%)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function toJson(input: ExportInput) {
  return {
    book: {
      title: input.bookTitle,
      author: input.bookAuthor,
    },
    exportedAt: new Date().toISOString(),
    highlights: input.highlights.map((h) => ({
      id: h.id,
      cfiRange: h.cfiRange,
      text: h.textContent,
      note: h.note,
      color: h.color,
      createdAt: h.createdAt,
    })),
    notes: input.notes.map((n) => ({
      id: n.id,
      type: n.noteType,
      text: n.textContent,
      position: n.position,
      createdAt: n.createdAt,
    })),
    bookmarks: input.bookmarks.map((b) => ({
      id: b.id,
      label: b.label,
      position: b.position,
      createdAt: b.createdAt,
    })),
  };
}
