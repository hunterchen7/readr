import {
  S3Client,
  type S3ClientConfig,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../lib/env.js";
import { PRESIGNED_URL_EXPIRY_SECONDS } from "@readr/shared";

// Build the S3 client config conditionally so we only pass `endpoint`
// when the operator actually set one. AWS S3 needs `endpoint` to be
// undefined for the SDK to resolve the regional endpoint from
// S3_REGION — passing any value (even the right one) pins the client
// to that host and breaks credential resolution for some IAM setups.
const clientConfig: S3ClientConfig = {
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
};
if (env.S3_ENDPOINT) clientConfig.endpoint = env.S3_ENDPOINT;
const s3 = new S3Client(clientConfig);

const bucket = env.S3_BUCKET;

/**
 * Public base URL for direct (non-signed) access to the bucket.
 *
 * IMPORTANT: `S3_PUBLIC_ENDPOINT` is always treated as a path-style
 * URL. We concatenate `/${bucket}/${key}` at URL-generation time, so
 * the operator MUST pass a host without the bucket name in it (e.g.
 * `https://s3.us-east-1.amazonaws.com`, NOT
 * `https://my-bucket.s3.us-east-1.amazonaws.com`). Passing the
 * virtual-hosted form would double the bucket name and yield NoSuchKey.
 */
const publicBase = env.S3_PUBLIC_ENDPOINT
  ? `${env.S3_PUBLIC_ENDPOINT.replace(/\/$/, "")}/${bucket}`
  : null;

export async function uploadFile(
  key: string,
  body: Buffer | ReadableStream,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getPresignedDownloadUrl(key: string): Promise<string> {
  // If the bucket is publicly readable, return a direct URL (no signing).
  // This avoids S3v4 host-header mismatches when proxied through CF tunnel.
  if (publicBase) return `${publicBase}/${key}`;

  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS },
  );
}

export async function deleteFile(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}
