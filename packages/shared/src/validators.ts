import { z } from "zod";

// === Book Position ===
export const bookPositionSchema = z.object({
  chapter: z.number().int().optional(),
  cfi: z.string().optional(),
  page: z.number().int().optional(),
  percentage: z.number().min(0).max(100),
});

// === Books ===
export const listBooksQuerySchema = z.object({
  sort: z
    .enum(["recent", "title", "author", "lastRead"])
    .default("recent"),
  search: z.string().optional(),
  format: z.enum(["epub", "pdf"]).optional(),
});

// Per-user overrides only. The file-level metadata (language, chapter
// count, cover) is immutable from the client's perspective because it's
// shared across every user that uploads the same bytes. Clients can only
// rename their own copy via title_override / author_override.
export const updateBookMetadataSchema = z.object({
  title: z.string().min(1).max(500).nullable().optional(),
  author: z.string().min(1).max(500).nullable().optional(),
});

// === Reading Progress ===
export const upsertProgressSchema = z.object({
  deviceId: z.string().min(1),
  position: bookPositionSchema,
});

// === Annotations ===
export const createBookmarkSchema = z.object({
  position: bookPositionSchema,
  label: z.string().optional(),
});

export const highlightColorSchema = z.enum(["yellow", "green", "blue", "pink", "purple"]);

export const createHighlightSchema = z.object({
  cfiRange: z.string().min(1),
  textContent: z.string().optional(),
  note: z.string().optional(),
  color: highlightColorSchema.default("yellow"),
});

export const strokePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  pressure: z.number(),
});

export const strokeSchema = z.object({
  points: z.array(strokePointSchema),
  color: z.string(),
  width: z.number().positive(),
});

export const penConfigSchema = z.object({
  color: z.string(),
  width: z.number().positive(),
});

export const createNoteSchema = z.object({
  position: bookPositionSchema,
  noteType: z.enum(["typed", "handwritten"]),
  textContent: z.string().optional(),
  strokes: z.array(strokeSchema).optional(),
  penConfig: penConfigSchema.optional(),
});

export const updateAnnotationSchema = z.object({
  label: z.string().optional(),
  note: z.string().optional(),
  color: highlightColorSchema.optional(),
  textContent: z.string().optional(),
  strokes: z.array(strokeSchema).optional(),
  penConfig: penConfigSchema.optional(),
});

// === Sync ===
export const syncPullQuerySchema = z.object({
  since: z.string().datetime(),
  deviceId: z.string().min(1),
});

export const syncLogEntrySchema = z.object({
  entityType: z.enum(["bookmark", "highlight", "note", "progress"]),
  entityId: z.string().uuid(),
  operation: z.enum(["create", "update", "delete"]),
  payload: z.record(z.unknown()).nullable(),
  deviceId: z.string().nullable(),
  timestamp: z.string().datetime(),
});

export const syncPushSchema = z.object({
  changes: z.array(syncLogEntrySchema),
});

// === TTS ===
export const voiceConfigSchema = z.object({
  voiceId: z.string().optional(),
  exaggeration: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
});

export const generateTTSSchema = z.object({
  bookId: z.string().uuid(),
  engine: z.enum(["chatterbox", "chatterbox-turbo", "kokoro"]).optional(),
  voiceConfig: voiceConfigSchema.optional(),
});

export const streamTTSSchema = z.object({
  text: z.string().min(1),
  voiceConfig: voiceConfigSchema.optional(),
});

// === Lookup Providers ===
export const createLookupProviderSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  urlTemplate: z.string().min(1).refine((s) => s.includes("{{query}}"), {
    message: "URL template must contain {{query}}",
  }),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const updateLookupProviderSchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
  urlTemplate: z
    .string()
    .min(1)
    .refine((s) => s.includes("{{query}}"), {
      message: "URL template must contain {{query}}",
    })
    .optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
