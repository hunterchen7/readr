import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),

  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_URL: z.string().url().optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: z
    .string()
    .transform((v) => v.split(",").map((s) => s.trim()))
    .default("http://localhost,http://localhost:8080"),

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
