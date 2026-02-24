import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { VoiceConfig } from "@readr/shared";

export const ttsQueue = new Queue("tts", { connection: redis });

interface QueueJobConfig {
  engine?: string;
  voiceConfig?: VoiceConfig;
}

/**
 * Queue a TTS generation job for a book.
 * Creates a DB record and enqueues chapter-level sub-jobs.
 */
export async function queueTTSJob(
  bookId: string,
  userId: string,
  config: QueueJobConfig,
  chapterTexts: string[],
) {
  const engine = config.engine ?? "chatterbox-turbo";

  const [job] = await db
    .insert(schema.ttsJobs)
    .values({
      bookId,
      userId,
      status: "queued",
      engine,
      chaptersTotal: chapterTexts.length,
      voiceConfig: config.voiceConfig ?? null,
    })
    .returning();

  // Add one sub-job per chapter for granular progress
  for (let i = 0; i < chapterTexts.length; i++) {
    await ttsQueue.add("generate-chapter", {
      jobId: job.id,
      bookId,
      userId,
      chapterIndex: i,
      text: chapterTexts[i],
      engine,
      voiceConfig: config.voiceConfig,
    });
  }

  return job;
}

/**
 * Get the current queue depth.
 */
export async function getQueueDepth(): Promise<number> {
  const counts = await ttsQueue.getJobCounts("waiting", "active", "delayed");
  return counts.waiting + counts.active + counts.delayed;
}
