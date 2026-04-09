import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

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
  /** JPEG-encoded, ≤600×900 cover. Null if the book has no extractable cover. */
  cover: Buffer | null;
}

/**
 * Extract title / author / language / cover from an EPUB or PDF.
 *
 * - EPUB: unzip, parse the OPF for Dublin Core metadata, find the cover
 *   image in the manifest, and re-encode it to a uniform JPEG.
 * - PDF: `pdf-parse` for the Info dict (title/author/language), and
 *   `pdftoppm` from poppler-utils to render page 1 as a JPEG.
 *
 * Extraction is best-effort. Any error falls back to a filename-derived
 * title so the upload still succeeds.
 */
export async function extractMetadata(
  buffer: Buffer,
  format: string,
  filename: string,
): Promise<ExtractedMetadata> {
  const fallbackTitle = cleanFilename(filename);

  try {
    if (format === "epub") {
      return await extractEpub(buffer, fallbackTitle);
    }
    if (format === "pdf") {
      return await extractPdf(buffer, fallbackTitle);
    }
  } catch (err) {
    console.warn(`metadata extract failed (${format}):`, err);
  }

  return {
    title: fallbackTitle,
    author: null,
    language: null,
    totalChapters: null,
    cover: null,
  };
}

function cleanFilename(filename: string): string {
  return (
    filename
      .replace(/\.(epub|pdf)$/i, "")
      .replace(/[_-]/g, " ")
      .trim() || "Untitled"
  );
}

// ─── EPUB ────────────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  trimValues: true,
});

async function extractEpub(
  buffer: Buffer,
  fallbackTitle: string,
): Promise<ExtractedMetadata> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. META-INF/container.xml → rootfile path
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("missing META-INF/container.xml");
  const container = xmlParser.parse(await containerFile.async("string"));
  const rootfile = container?.container?.rootfiles?.rootfile;
  const opfPath: string | undefined = Array.isArray(rootfile)
    ? rootfile[0]?.["@_full-path"]
    : rootfile?.["@_full-path"];
  if (!opfPath) throw new Error("no rootfile in container.xml");

  // 2. OPF → Dublin Core metadata block
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`missing opf file ${opfPath}`);
  const opf = xmlParser.parse(await opfFile.async("string"));
  const pkg = opf?.package;
  const metadata = pkg?.metadata;

  const title = pickText(metadata?.["dc:title"]) ?? fallbackTitle;
  const author = pickText(metadata?.["dc:creator"]);
  const language = pickText(metadata?.["dc:language"]);

  const itemrefs = pkg?.spine?.itemref;
  const totalChapters = Array.isArray(itemrefs)
    ? itemrefs.length
    : itemrefs
      ? 1
      : null;

  const cover = await findEpubCover(zip, opfPath, pkg);
  return { title, author, language, totalChapters, cover };
}

function pickText(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = pickText(v);
      if (s) return s;
    }
    return null;
  }
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    if (typeof text === "string") return text.trim() || null;
  }
  return null;
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function findEpubCover(
  zip: JSZip,
  opfPath: string,
  pkg: unknown,
): Promise<Buffer | null> {
  const pkgObj = pkg as {
    metadata?: { meta?: unknown };
    manifest?: { item?: unknown };
  };
  const manifestItems = normalizeArray(pkgObj?.manifest?.item).filter(
    (x): x is Record<string, string> => typeof x === "object" && x !== null,
  );

  // EPUB 3: <item properties="cover-image">
  let coverHref: string | null = null;
  for (const item of manifestItems) {
    if ((item["@_properties"] ?? "").includes("cover-image")) {
      coverHref = item["@_href"] ?? null;
      break;
    }
  }

  // EPUB 2: <meta name="cover" content="ID"> then resolve id → item
  if (!coverHref) {
    const metas = normalizeArray(pkgObj?.metadata?.meta).filter(
      (x): x is Record<string, string> => typeof x === "object" && x !== null,
    );
    const coverMeta = metas.find((m) => m["@_name"] === "cover");
    const coverId = coverMeta?.["@_content"];
    if (coverId) {
      coverHref = manifestItems.find((x) => x["@_id"] === coverId)?.["@_href"] ?? null;
    }
  }

  // Fallback: first image item whose id mentions "cover"
  if (!coverHref) {
    const guess = manifestItems.find(
      (x) =>
        (x["@_id"] ?? "").toLowerCase().includes("cover") &&
        (x["@_media-type"] ?? "").startsWith("image/"),
    );
    coverHref = guess?.["@_href"] ?? null;
  }

  if (!coverHref) return null;

  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
    : "";
  const coverFile = zip.file(opfDir + coverHref);
  if (!coverFile) return null;
  const raw = await coverFile.async("nodebuffer");
  return normalizeCover(raw);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

async function extractPdf(
  buffer: Buffer,
  fallbackTitle: string,
): Promise<ExtractedMetadata> {
  const mod = await import("pdf-parse");
  const pdfParse = (mod as unknown as { default: (buf: Buffer) => Promise<{ info?: Record<string, string>; numpages?: number }>; }).default ?? (mod as unknown as (buf: Buffer) => Promise<{ info?: Record<string, string>; numpages?: number }>);

  let info: { Title?: string; Author?: string; Language?: string } = {};
  let numPages: number | null = null;
  try {
    const parsed = await pdfParse(buffer);
    info = (parsed.info as typeof info) ?? {};
    numPages = typeof parsed.numpages === "number" ? parsed.numpages : null;
  } catch (err) {
    console.warn("pdf-parse failed:", err);
  }

  const title = nonEmpty(info.Title) ?? fallbackTitle;
  const author = nonEmpty(info.Author);
  const language = nonEmpty(info.Language);

  const cover = await renderPdfCover(buffer);

  return {
    title,
    author,
    language,
    totalChapters: numPages,
    cover,
  };
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Render page 1 of a PDF to a JPEG using poppler's `pdftoppm`. Requires
 * `poppler-utils` to be installed in the container (added to Dockerfile).
 * Returns null if pdftoppm is unavailable or the PDF can't be rendered.
 */
async function renderPdfCover(buffer: Buffer): Promise<Buffer | null> {
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(tmpdir(), "readr-pdf-"));
    const inputPath = join(tmp, "in.pdf");
    const outputPrefix = join(tmp, "out");
    await writeFile(inputPath, buffer);
    // pdftoppm -jpeg -r 100 -f 1 -l 1 in.pdf out  → writes out-1.jpg
    await execFileAsync("pdftoppm", [
      "-jpeg",
      "-r",
      "100",
      "-f",
      "1",
      "-l",
      "1",
      inputPath,
      outputPrefix,
    ]);
    const rendered = await readFile(`${outputPrefix}-1.jpg`);
    return normalizeCover(rendered);
  } catch (err) {
    console.warn("pdftoppm failed:", err);
    return null;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Shared ──────────────────────────────────────────────────────────────────

/**
 * Re-encode a raw image buffer to a ~600×900 progressive JPEG. Used for
 * both EPUB and PDF covers so the library grid is uniform and thumbnails
 * stay small (~50-80 KB each).
 */
async function normalizeCover(raw: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(raw)
      .resize(600, 900, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn("sharp cover resize failed:", err);
    return null;
  }
}
