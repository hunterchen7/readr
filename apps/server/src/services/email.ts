import { Resend } from "resend";
import { env } from "../lib/env.js";

/**
 * Thin wrapper around Resend so the rest of the code can treat email
 * as a feature that is either "configured" or "not configured". If
 * RESEND_API_KEY isn't set the feature is entirely off — routes short
 * circuit with 503 and the mobile UI hides the recovery affordance.
 */

let client: Resend | null = null;
function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export function isEmailEnabled(): boolean {
  return !!(env.RESEND_API_KEY && env.RESEND_FROM);
}

export async function sendVerificationCode(opts: {
  to: string;
  code: string;
  purpose: "attach" | "recover" | "login";
}): Promise<void> {
  const r = getClient();
  if (!r || !env.RESEND_FROM) {
    throw new Error("email not configured");
  }
  const subject =
    opts.purpose === "login"
      ? "Your Readr login code"
      : opts.purpose === "attach"
        ? "Verify your Readr recovery email"
        : "Your Readr device token";

  const bodies: Record<string, string> = {
    login: `Your Readr login code is:\n\n${opts.code}\n\nEnter this in the app to sign in. It expires in 15 minutes.\n\nIf you didn't request this, just ignore this email.`,
    attach: `Your Readr verification code is ${opts.code}.\n\nEnter this in Settings to link this email to your account. It expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
    recover: `Your Readr recovery code is:\n\n${opts.code}\n\nEnter it on the recovery screen to retrieve your account. It expires in 15 minutes.\n\nIf you didn't request this, just ignore it.`,
  };
  const body = bodies[opts.purpose];

  await r.emails.send({
    from: env.RESEND_FROM,
    to: opts.to,
    subject,
    text: body,
  });
}

export async function sendDeviceTokenRecovery(opts: {
  to: string;
  token: string;
}): Promise<void> {
  const r = getClient();
  if (!r || !env.RESEND_FROM) {
    throw new Error("email not configured");
  }
  await r.emails.send({
    from: env.RESEND_FROM,
    to: opts.to,
    subject: "Your Readr device token",
    text: `Here's your Readr device token:

${opts.token}

Paste it into the Readr app's sign-in screen under "Device token"
and you'll be back in your library.

Treat this token like a password — anyone who has it can read and
write your library.`,
  });
}

/**
 * Generate a cryptographically-random 6-digit code as a zero-padded
 * string. We use crypto.getRandomValues instead of Math.random so the
 * code isn't predictable.
 */
export function generateVerificationCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  return String(Math.abs(n) % 1_000_000).padStart(6, "0");
}
