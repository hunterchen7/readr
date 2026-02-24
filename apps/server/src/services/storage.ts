import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../lib/env.js";
import { PRESIGNED_URL_EXPIRY_SECONDS } from "@readr/shared";

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
});

const bucket = env.S3_BUCKET;

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
