import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  buildExportBody,
  extForFormat,
  mimeForFormat,
  sanitizeFileBase,
  type ExportInput,
} from "./export-annotations-body";

export type { ExportFormat, ExportInput } from "./export-annotations-body";

/**
 * Serialize the user's highlights/notes/bookmarks for a book and push
 * the result through the OS share sheet as a real file. Markdown is the
 * default because it reads nicely in anything that renders it; JSON is
 * available for pipelines that want structured data.
 *
 * Web counterpart lives in export-annotations.web.ts and triggers a
 * regular browser download instead.
 */
export async function exportAnnotations(input: ExportInput): Promise<void> {
  const base = sanitizeFileBase(input.bookTitle);
  const ext = extForFormat(input.format);
  const mime = mimeForFormat(input.format);
  const fileName = `${base}.${ext}`;
  const uri = `${FileSystem.cacheDirectory}${fileName}`;

  const body = buildExportBody(input);
  await FileSystem.writeAsStringAsync(uri, body);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: mime,
      dialogTitle: `Export ${base}`,
      UTI: input.format === "json" ? "public.json" : "net.daringfireball.markdown",
    });
  }
}
