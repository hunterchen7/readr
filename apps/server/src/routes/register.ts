import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { badRequest } from "../lib/errors.js";

const app = new Hono();

/**
 * Bearer-token registration. The client generates a long random token,
 * POSTs it here once, and then includes it as `Authorization: Bearer <token>`
 * on every subsequent request. Idempotent — if the token already exists
 * the existing user row is returned unchanged.
 *
 * The user PK is a server-generated UUID. The token is stored in a
 * separate column with a unique index. Anyone who knows a token IS
 * that user, so the client must store it in SecureStore / a password
 * manager and treat it like a password.
 */
const registerSchema = z.object({
  token: z
    .string()
    .min(16, "token must be at least 16 characters")
    .max(256, "token too long")
    .regex(/^[A-Za-z0-9_-]+$/, "token may only contain A-Z, a-z, 0-9, _ and -"),
  name: z.string().max(80).optional(),
});

app.post("/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Body must be JSON");
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { token, name } = parsed.data;

  const [existing] = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.token, token))
    .limit(1);

  if (existing) {
    return c.json({ user: existing, created: false });
  }

  const [created] = await db
    .insert(schema.users)
    .values({ token, name: name ?? null })
    .returning({ id: schema.users.id, name: schema.users.name });

  return c.json({ user: created, created: true }, 201);
});

export default app;
