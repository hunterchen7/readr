import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { AppError } from "./lib/errors.js";
import { auth } from "./routes/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import booksRouter from "./routes/books.js";
import annotationsRouter from "./routes/annotations.js";
import progressRouter from "./routes/progress.js";
import syncRouter from "./routes/sync.js";
import ttsRouter from "./routes/tts.js";
import exportRouter from "./routes/export.js";

const app = new Hono();

// Request logging
app.use("*", logger());

// CORS
app.use(
  "/api/*",
  cors({
    origin: env.BETTER_AUTH_TRUSTED_ORIGINS,
    credentials: true,
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

// Auth routes (handled by better-auth)
app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));

// Protected API routes
app.use("/api/*", authMiddleware);
app.use("/api/*", apiRateLimit);

app.route("/api/books", booksRouter);
app.route("/api", annotationsRouter);
app.route("/api/books", progressRouter);
app.route("/api", syncRouter);
app.route("/api", ttsRouter);
app.route("/api", exportRouter);

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
