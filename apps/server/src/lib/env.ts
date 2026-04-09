import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  TTS_WORKER_URL: z.string().url().optional(),

  S3_ENDPOINT: z.string().url(),
  // Public-facing endpoint used ONLY when rewriting presigned URLs that
  // clients (mobile/web) will hit directly. In local dev this is the
  // host alias the Android emulator can reach (http://10.0.2.2:9000);
  // in production this is the R2 public host. If unset, S3_ENDPOINT is used.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  PUBLIC_URL: z.string().url().optional(),

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
