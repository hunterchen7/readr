import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";

export const scopeToUser = {
  books: (userId: string) => eq(schema.books.userId, userId),
  bookmarks: (userId: string) => eq(schema.bookmarks.userId, userId),
  highlights: (userId: string) => eq(schema.highlights.userId, userId),
  notes: (userId: string) => eq(schema.notes.userId, userId),
  readingProgress: (userId: string) =>
    eq(schema.readingProgress.userId, userId),
  ttsJobs: (userId: string) => eq(schema.ttsJobs.userId, userId),
  lookupProviders: (userId: string) =>
    eq(schema.lookupProviders.userId, userId),
  collections: (userId: string) =>
    eq(schema.collections.userId, userId),
  readingSessions: (userId: string) =>
    eq(schema.readingSessions.userId, userId),
} as const;
