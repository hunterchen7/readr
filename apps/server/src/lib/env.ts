import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  TTS_WORKER_URL: z.string().url().optional(),

  // Optional. For AWS S3 the SDK resolves the regional endpoint from
  // S3_REGION when no endpoint is set, and passing any value (even a
  // correct one) pins the client to that host. So leave this unset for
  // AWS, and set it explicitly for MinIO / R2 / B2 / DO Spaces.
  S3_ENDPOINT: z.string().url().optional(),
  // Public-facing endpoint used ONLY when rewriting presigned URLs that
  // clients (mobile/web) will hit directly. In local dev this is the
  // host alias the Android emulator can reach (http://10.0.2.2:9000);
  // in production this is the R2 public host. Must be PATH-STYLE — we
  // concatenate /<bucket>/<key> at URL-generation time in storage.ts,
  // so passing a virtual-hosted URL (e.g. https://my-bucket.s3.amazonaws.com)
  // would double the bucket name. If unset, presigned URLs are signed
  // against S3_ENDPOINT instead.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  // Defaults to false because AWS S3 and Cloudflare R2 use virtual-hosted
  // style addressing. MinIO operators must set this to "true" explicitly.
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  PUBLIC_URL: z.string().url().optional(),

  // === Resend (optional — email recovery) ===
  // Leave unset to disable the whole email feature. When set, the
  // /api/email/* routes become available and the mobile Settings
  // screen shows the "attach recovery email" flow.
  RESEND_API_KEY: z.string().optional(),
  // From address for outbound mail. Must be on a Cloudflare / Resend
  // verified domain. Example: Readr <readr@reader.example.com>
  RESEND_FROM: z.string().optional(),

  // Comma-separated list of allowed CORS origins. Defaults to "*"
  // (any origin) which is safe with bearer-token auth but can be
  // tightened in production for defense-in-depth.
  CORS_ORIGINS: z.string().default("*"),

  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("debug"),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(500),
  DEFAULT_STORAGE_QUOTA_MB: z.coerce.number().default(1024),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();
