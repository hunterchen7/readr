import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { AppError } from "./lib/errors.js";
import { auth } from "./routes/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import booksRouter from "./routes/books.js";
import annotationsRouter from "./routes/annotations.js";
import progressRouter from "./routes/progress.js";
import syncRouter from "./routes/sync.js";
import ttsRouter from "./routes/tts.js";

const app = new Hono();

// CORS
app.use(
  "/api/*",
  cors({
    origin: env.BETTER_AUTH_TRUSTED_ORIGINS,
    credentials: true,
  }),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Auth routes (handled by better-auth)
app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));

// Protected API routes
app.use("/api/*", authMiddleware);
app.route("/api/books", booksRouter);
app.route("/api", annotationsRouter);
app.route("/api/books", progressRouter);
app.route("/api", syncRouter);
app.route("/api", ttsRouter);

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
