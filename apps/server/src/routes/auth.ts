import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import { env } from "../lib/env.js";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 min
    },
  },
});
