import type { Context, Next } from "hono";

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
}

// Simple in-memory rate limiter (upgrade to Redis-backed for multi-instance)
const counters = new Map<string, { count: number; resetAt: number }>();

function getKey(prefix: string, identifier: string): string {
  return `${prefix}:${identifier}`;
}

export function rateLimit(config: RateLimitConfig) {
  return async (c: Context, next: Next) => {
    const userId = c.get("userId") as string | undefined;
    const ip = c.req.header("x-forwarded-for") ?? "unknown";
    const identifier = userId ?? ip;
    const key = getKey(config.keyPrefix, identifier);
    const now = Date.now();

    let entry = counters.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + config.windowMs };
      counters.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header("X-RateLimit-Limit", String(config.max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, config.max - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > config.max) {
      return c.json(
        { error: "Too many requests. Please try again later." },
        429,
      );
    }

    await next();
  };
}

// Preset rate limiters
export const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyPrefix: "upload",
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  keyPrefix: "api",
});

// Periodic cleanup of expired entries (unref so it doesn't prevent graceful shutdown)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of counters) {
    if (now >= entry.resetAt) {
      counters.delete(key);
    }
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();
