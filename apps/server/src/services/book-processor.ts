import { createHash } from "node:crypto";

export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function getFileExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ext;
}

export function getContentType(format: string): string {
  switch (format) {
    case "epub":
      return "application/epub+zip";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export interface ExtractedMetadata {
  title: string | null;
  author: string | null;
  language: string | null;
  totalChapters: number | null;
}

/** Basic metadata extraction — will be enhanced with epub-metadata and pdf-parse later */
export async function extractMetadata(
  buffer: Buffer,
  format: string,
  filename: string,
): Promise<ExtractedMetadata> {
  // For now, use filename as title. Full metadata extraction (epub-metadata, pdf-parse)
  // will be added when we polish the upload flow.
  const titleFromFilename = filename
    .replace(/\.(epub|pdf)$/i, "")
    .replace(/[_-]/g, " ")
    .trim();

  return {
    title: titleFromFilename || null,
    author: null,
    language: null,
    totalChapters: null,
  };
}
