import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";

type AuthEnv = {
  Variables: {
    userId: string;
  };
};

/**
 * Bearer-token auth. The client sends `Authorization: Bearer <token>`,
 * where <token> is a long random string generated on first launch and
 * stored in SecureStore. The token IS the user id — no passwords, no
 * sessions, no OAuth. A user row must exist for the token (created via
 * `POST /api/register` before the first authed request).
 */
export async function authMiddleware(c: Context<AuthEnv>, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token || token.length < 16) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Cheap existence check. The token is the primary key, so this is an
  // index seek. We don't cache because it also doubles as revocation —
  // deleting the user row immediately locks them out.
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, token))
    .limit(1);

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId", user.id);
  return next();
}
