import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { AppError } from "./lib/errors.js";
import { authMiddleware } from "./middleware/auth.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import registerRouter from "./routes/register.js";
import booksRouter from "./routes/books.js";
import annotationsRouter from "./routes/annotations.js";
import progressRouter from "./routes/progress.js";
import syncRouter from "./routes/sync.js";
import ttsRouter from "./routes/tts.js";
import exportRouter from "./routes/export.js";
import collectionsRouter from "./routes/collections.js";
import statsRouter from "./routes/stats.js";
import emailRouter, { emailPublicRouter } from "./routes/email.js";
import dictionaryRouter from "./routes/dictionary.js";

const app = new Hono();

// Request logging
app.use("*", logger());

// CORS — defaults to wildcard (safe with bearer-token auth). Set
// CORS_ORIGINS to a comma-separated list of origins in production
// for defense-in-depth (e.g. "https://read.example.com,http://localhost:5173").
const allowedOrigins = env.CORS_ORIGINS === "*"
  ? null // null = allow any origin
  : new Set(env.CORS_ORIGINS.split(",").map((o) => o.trim()));

app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (!allowedOrigins) return origin ?? "*";
      return origin && allowedOrigins.has(origin) ? origin : "";
    },
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  }),
);

// Health check (no auth required)
app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: process.env.npm_package_version ?? "0.0.1",
    uptime: Math.floor(process.uptime()),
  }),
);

// Public registration endpoint — mobile/web POSTs a freshly-generated
// token here on first launch to create a user row. Idempotent.
app.route("/api", registerRouter);

// Public email endpoints (status check + device token recovery).
// These must be BEFORE authMiddleware so unauthenticated users can
// recover their device token via email.
app.route("/api", emailPublicRouter);

// Public dictionary endpoint — no auth required so it works before
// login and keeps overhead low. Backed by a SQLite database built from
// Wiktionary + WordNet data (see scripts/build-dictionary.mjs).
app.route("/api", dictionaryRouter);

// Protected API routes
app.use("/api/*", authMiddleware);
app.use("/api/*", apiRateLimit);

app.route("/api/books", booksRouter);
app.route("/api", annotationsRouter);
app.route("/api/books", progressRouter);
app.route("/api", syncRouter);
app.route("/api", ttsRouter);
app.route("/api", exportRouter);
app.route("/api/collections", collectionsRouter);
app.route("/api", statsRouter);
app.route("/api", emailRouter);

// Global error handler. Hono's c.json overload requires a
// ContentfulStatusCode literal, so we cast through `as` to our dynamic
// AppError.statusCode. This now actually honors the real status
// (the previous `as 400` silently pinned everything to 400).
app.onError((err, c) => {
  if (err instanceof AppError) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json({ error: err.message }, err.statusCode as any);
  }

  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

console.log(`Starting server on port ${env.PORT}...`);
// hostname "0.0.0.0" is required so the Android emulator can reach the
// dev server via 10.0.2.2. Without it, @hono/node-server binds to IPv6
// localhost only on some macOS setups, leaving IPv4 loopback unreachable.
serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" });
console.log(`Server running at http://localhost:${env.PORT}`);

export default app;
