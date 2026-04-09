import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { badRequest, forbidden } from "../lib/errors.js";
import {
  generateVerificationCode,
  isEmailEnabled,
  sendDeviceTokenRecovery,
  sendVerificationCode,
} from "../services/email.js";

type Variables = { userId?: string };

const FIFTEEN_MIN = 15 * 60 * 1000;
const emailSchema = z.string().email().max(254);

// ---- Public (unauthenticated) endpoints ----
export const emailPublicRouter = new Hono<{ Variables: Variables }>();

/**
 * GET /email/status — is the email feature available on this server?
 * Public (no auth). Lets the mobile client decide whether to show the
 * "attach email" button at all.
 */
emailPublicRouter.get("/email/status", (c) =>
  c.json({ enabled: isEmailEnabled() }),
);

/**
 * POST /email/recover/start — UNAUTHENTICATED. User enters an email;
 * if a verified user row with that email exists we email them a code.
 * Always returns 200 regardless so the endpoint doesn't leak which
 * emails are registered.
 */
emailPublicRouter.post("/email/recover/start", async (c) => {
  if (!isEmailEnabled()) return c.json({ error: "email disabled" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ email: emailSchema }).safeParse(body);
  if (!parsed.success) throw badRequest("Valid email required");
  const email = parsed.data.email.toLowerCase();

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (user) {
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + FIFTEEN_MIN);
    await db.insert(schema.emailVerifications).values({
      email,
      code,
      purpose: "recover",
      userId: user.id,
      expiresAt,
    });
    await sendVerificationCode({ to: email, code, purpose: "recover" });
  }
  // Always 200 — don't leak registration state.
  return c.json({ sent: true });
});

/**
 * POST /email/recover/finish — UNAUTHENTICATED. User submits the code
 * they received. If valid, we email them the device token for the
 * matching user row. Code is consumed on success.
 */
emailPublicRouter.post("/email/recover/finish", async (c) => {
  if (!isEmailEnabled()) return c.json({ error: "email disabled" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      email: emailSchema,
      code: z.string().length(6),
    })
    .safeParse(body);
  if (!parsed.success) throw badRequest("Valid email and 6-digit code required");
  const email = parsed.data.email.toLowerCase();

  const [row] = await db
    .select()
    .from(schema.emailVerifications)
    .where(
      and(
        eq(schema.emailVerifications.email, email),
        eq(schema.emailVerifications.code, parsed.data.code),
        eq(schema.emailVerifications.purpose, "recover"),
        isNull(schema.emailVerifications.consumedAt),
        gt(schema.emailVerifications.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row || !row.userId) {
    // Generic error so we don't leak whether the email or the code
    // was wrong.
    throw badRequest("Invalid or expired code");
  }

  // Mark consumed and send the token.
  await db
    .update(schema.emailVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(schema.emailVerifications.id, row.id));

  await sendDeviceTokenRecovery({ to: email, token: row.userId });

  return c.json({ sent: true });
});

// ---- Authenticated endpoints (mounted under /api after auth middleware) ----
const emailRouter = new Hono<{ Variables: Variables }>();

/**
 * POST /email/attach — authenticated. The user supplies an email they
 * want to link to their current account; we persist it (unverified)
 * and email them a 6-digit code. Subsequent call to /email/verify
 * stamps emailVerifiedAt.
 */
emailRouter.post("/email/attach", async (c) => {
  if (!isEmailEnabled()) return c.json({ error: "email disabled" }, 503);
  const userId = c.get("userId");
  if (!userId) throw forbidden("Not authenticated");

  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ email: emailSchema }).safeParse(body);
  if (!parsed.success) throw badRequest("Valid email required");
  const email = parsed.data.email.toLowerCase();

  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + FIFTEEN_MIN);

  // Persist the pending code before sending to avoid leaking timing
  // information about existing emails.
  await db.insert(schema.emailVerifications).values({
    email,
    code,
    purpose: "attach",
    userId,
    expiresAt,
  });

  // Tentatively write the unverified email onto the user row so the
  // UI can show "pending confirmation". We stamp emailVerifiedAt only
  // on successful /verify.
  await db
    .update(schema.users)
    .set({ email, emailVerifiedAt: null })
    .where(eq(schema.users.id, userId));

  await sendVerificationCode({ to: email, code, purpose: "attach" });
  return c.json({ sent: true });
});

/**
 * POST /email/verify — authenticated. Consume a pending attach code
 * for the current user.
 */
emailRouter.post("/email/verify", async (c) => {
  if (!isEmailEnabled()) return c.json({ error: "email disabled" }, 503);
  const userId = c.get("userId");
  if (!userId) throw forbidden("Not authenticated");

  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({ code: z.string().length(6) })
    .safeParse(body);
  if (!parsed.success) throw badRequest("Valid 6-digit code required");
  const code = parsed.data.code;

  const [row] = await db
    .select()
    .from(schema.emailVerifications)
    .where(
      and(
        eq(schema.emailVerifications.userId, userId),
        eq(schema.emailVerifications.code, code),
        eq(schema.emailVerifications.purpose, "attach"),
        isNull(schema.emailVerifications.consumedAt),
        gt(schema.emailVerifications.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) throw badRequest("Invalid or expired code");

  await db
    .update(schema.emailVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(schema.emailVerifications.id, row.id));

  await db
    .update(schema.users)
    .set({ email: row.email, emailVerifiedAt: new Date() })
    .where(eq(schema.users.id, userId));

  return c.json({ verified: true });
});

export default emailRouter;
