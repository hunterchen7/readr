/**
 * Web implementation of exportAnnotations. The native version
 * writes to the app's cache directory and pushes the file through
 * expo-sharing's OS share sheet. On the web, neither exists — we
 * build a Blob, create an object URL, and click a hidden anchor to
 * trigger a regular browser download.
 *
 * Serialization is shared with the native path via
 * export-annotations-body.ts.
 */
import {
  buildExportBody,
  extForFormat,
  mimeForFormat,
  sanitizeFileBase,
  type ExportInput,
} from "./export-annotations-body";

export type { ExportFormat, ExportInput } from "./export-annotations-body";

export async function exportAnnotations(input: ExportInput): Promise<void> {
  if (typeof document === "undefined") return;

  const base = sanitizeFileBase(input.bookTitle);
  const ext = extForFormat(input.format);
  const mime = mimeForFormat(input.format);
  const fileName = `${base}.${ext}`;

  const body = buildExportBody(input);
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke on the next tick — revoking synchronously sometimes
  // cancels the download in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
