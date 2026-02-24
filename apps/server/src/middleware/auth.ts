import type { Context, Next } from "hono";
import { auth } from "../routes/auth.js";

type AuthEnv = {
  Variables: {
    userId: string;
  };
};

export async function authMiddleware(c: Context<AuthEnv>, next: Next) {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId", session.user.id);
  return next();
}
