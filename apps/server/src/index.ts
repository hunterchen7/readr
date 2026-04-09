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

const app = new Hono();

// Request logging
app.use("*", logger());

// CORS — wildcard is fine because the client sends a bearer token, not a
// cookie, so there's no ambient authority to worry about. Credentials
// are no longer needed.
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin ?? "*",
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

// Global error handler
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message }, err.statusCode as 400);
  }

  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

console.log(`Starting server on port ${env.PORT}...`);
serve({ fetch: app.fetch, port: env.PORT });
console.log(`Server running at http://localhost:${env.PORT}`);

export default app;
