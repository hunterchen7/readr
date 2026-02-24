import { Hono } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { generateTTSSchema, streamTTSSchema } from "@readr/shared";
import { scopeToUser } from "../middleware/user-scope.js";
import { env } from "../lib/env.js";
import { queueTTSJob, getQueueDepth } from "../services/tts-queue.js";
import { getPresignedDownloadUrl } from "../services/storage.js";

type Variables = { userId: string };

const ttsRouter = new Hono<{ Variables: Variables }>();

// GET /tts/status
ttsRouter.get("/tts/status", async (c) => {
  let available = false;
  let engines: string[] = [];
  let streamingAvailable = false;

  if (env.TTS_WORKER_URL) {
    try {
      const res = await fetch(`${env.TTS_WORKER_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          status: string;
          engines?: string[];
          gpu?: boolean;
        };
        available = data.status === "ok";
        engines = data.engines ?? [];
        streamingAvailable = engines.includes("kokoro");
      }
    } catch {
      // Worker unreachable
    }
  }

  const queueDepth = available ? await getQueueDepth() : 0;

  return c.json({ available, engines, streamingAvailable, queueDepth });
});

// POST /tts/generate
ttsRouter.post("/tts/generate", async (c) => {
  const userId = c.get("userId");
  const body = generateTTSSchema.parse(await c.req.json());

  // Verify book belongs to user
  const [book] = await db
    .select()
    .from(schema.books)
    .where(and(eq(schema.books.id, body.bookId), scopeToUser.books(userId)))
    .limit(1);

  if (!book) {
    return c.json({ error: "Book not found" }, 404);
  }

  // TODO: Extract chapter texts from book file
  // For now, create a placeholder job — actual text extraction
  // requires parsing the EPUB/PDF which will be added with the worker
  const chapterTexts = ["Chapter text placeholder"];

  const job = await queueTTSJob(body.bookId, userId, {
    engine: body.engine,
    voiceConfig: body.voiceConfig,
  }, chapterTexts);

  return c.json({ job }, 201);
});

// GET /tts/jobs
ttsRouter.get("/tts/jobs", async (c) => {
  const userId = c.get("userId");

  const jobs = await db
    .select()
    .from(schema.ttsJobs)
    .where(scopeToUser.ttsJobs(userId))
    .orderBy(schema.ttsJobs.createdAt);

  return c.json({ jobs });
});

// GET /tts/jobs/:id
ttsRouter.get("/tts/jobs/:id", async (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("id");

  const [job] = await db
    .select()
    .from(schema.ttsJobs)
    .where(and(eq(schema.ttsJobs.id, jobId), scopeToUser.ttsJobs(userId)))
    .limit(1);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const chunks = await db
    .select()
    .from(schema.ttsAudioChunks)
    .where(eq(schema.ttsAudioChunks.jobId, jobId))
    .orderBy(schema.ttsAudioChunks.chapterIndex);

  return c.json({ job, chunks });
});

// DELETE /tts/jobs/:id
ttsRouter.delete("/tts/jobs/:id", async (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("id");

  const [job] = await db
    .select()
    .from(schema.ttsJobs)
    .where(and(eq(schema.ttsJobs.id, jobId), scopeToUser.ttsJobs(userId)))
    .limit(1);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  // Delete audio chunks and the job
  await db.delete(schema.ttsAudioChunks).where(eq(schema.ttsAudioChunks.jobId, jobId));
  await db.delete(schema.ttsJobs).where(eq(schema.ttsJobs.id, jobId));

  // TODO: Delete audio files from S3

  return c.json({ deleted: true });
});

// GET /tts/audio/:bookId/:chapter
ttsRouter.get("/tts/audio/:bookId/:chapter", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("bookId");
  const chapterIndex = parseInt(c.req.param("chapter"), 10);

  if (isNaN(chapterIndex)) {
    return c.json({ error: "Invalid chapter index" }, 400);
  }

  // Find the latest completed job for this book
  const [job] = await db
    .select()
    .from(schema.ttsJobs)
    .where(
      and(
        eq(schema.ttsJobs.bookId, bookId),
        scopeToUser.ttsJobs(userId),
        eq(schema.ttsJobs.status, "done"),
      ),
    )
    .limit(1);

  if (!job) {
    return c.json({ error: "No completed TTS job for this book" }, 404);
  }

  const [chunk] = await db
    .select()
    .from(schema.ttsAudioChunks)
    .where(
      and(
        eq(schema.ttsAudioChunks.jobId, job.id),
        eq(schema.ttsAudioChunks.chapterIndex, chapterIndex),
      ),
    )
    .limit(1);

  if (!chunk) {
    return c.json({ error: "Audio not yet generated for this chapter" }, 404);
  }

  const url = await getPresignedDownloadUrl(chunk.audioKey);
  return c.json({ url });
});

// POST /tts/stream — proxy to Kokoro streaming endpoint
ttsRouter.post("/tts/stream", async (c) => {
  if (!env.TTS_WORKER_URL) {
    return c.json({ error: "TTS worker not configured" }, 503);
  }

  const body = await c.req.json();
  const parsed = streamTTSSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const res = await fetch(`${env.TTS_WORKER_URL}/tts/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: parsed.data.text,
        voice_config: parsed.data.voiceConfig,
      }),
    });

    if (!res.ok || !res.body) {
      return c.json({ error: "TTS streaming failed" }, 502);
    }

    // Stream the audio response through
    return new Response(res.body, {
      headers: {
        "Content-Type": "audio/ogg",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch {
    return c.json({ error: "TTS worker unreachable" }, 502);
  }
});

export default ttsRouter;
