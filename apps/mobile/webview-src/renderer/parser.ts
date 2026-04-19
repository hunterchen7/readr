/// <reference lib="dom" />
/**
 * EPUB parser. Unzips an EPUB file, reads the OPF package, extracts
 * spine items as sanitized HTML strings, and materializes internal
 * resources (images, CSS, fonts) as blob URLs for the WebView to load.
 */

import { unzipSync, strFromU8 } from 'fflate';

export interface SpineItem {
  /** Index in the spine. */
  index: number;
  /** OPF manifest id. */
  id: string;
  /** Absolute path inside the EPUB (e.g. "OEBPS/chap01.xhtml"). */
  path: string;
  /** Encoded href relative to the OPF — CFI-resolvable. */
  href: string;
  /** Parsed body HTML with resource URLs rewritten to blob URLs. */
  bodyHtml: string;
  /** Inlined stylesheet text, with resource URLs rewritten. */
  styles: string;
  /** Original XHTML document root. Used by CFI resolution. */
  doc: Document;
  /** Linear spine flag — non-linear items skipped by default navigation. */
  linear: boolean;
}

export interface TocItem {
  label: string;
  /** Href pointing into a spine item. May include a fragment "#id". */
  href: string;
  depth: number;
  subitems?: TocItem[];
}

export interface BookMetadata {
  title: string;
  author: string;
  language?: string;
  identifier?: string;
}

export interface ParsedBook {
  metadata: BookMetadata;
  spine: SpineItem[];
  toc: TocItem[];
  /** Blob URLs keyed by absolute EPUB path — used for CFI→href resolution. */
  resources: Map<string, string>;
  /** OPF id → absolute EPUB path. */
  manifestIdToPath: Map<string, string>;
  /** OPF's own path for href-resolution tracking. */
  opfPath: string;
  /** Blob URLs we created; call to revoke them on unmount. */
  revoke: () => void;
}

// ─── Path / URL helpers ──────────────────────────────────────────────

/**
 * Resolve a relative EPUB path against a base. EPUB paths use POSIX
 * separators, no leading slashes, and no host/authority — URL() would
 * resolve them incorrectly.
 */
function resolvePath(base: string, rel: string): string {
  if (!rel) return base;
  // Absolute inside EPUB package.
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function splitFragment(href: string): { path: string; fragment: string | null } {
  const i = href.indexOf('#');
  if (i < 0) return { path: href, fragment: null };
  return { path: href.slice(0, i), fragment: href.slice(i + 1) };
}

function mimeTypeForPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'application/xhtml+xml';
    case 'css': return 'text/css';
    case 'js': return 'application/javascript';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'woff': return 'font/woff';
    case 'woff2': return 'font/woff2';
    case 'ttf': return 'font/ttf';
    case 'otf': return 'font/otf';
    case 'opf': return 'application/oebps-package+xml';
    case 'ncx': return 'application/x-dtbncx+xml';
    case 'xml': return 'application/xml';
    default: return 'application/octet-stream';
  }
}

// ─── XML parsing ─────────────────────────────────────────────────────

function parseXml(text: string, mime: DOMParserSupportedType = 'application/xml'): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, mime);
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent);
  return doc;
}

function elemTextNS(el: Element | null, ns: string, name: string): string {
  const items = el?.getElementsByTagNameNS(ns, name);
  return items?.[0]?.textContent?.trim() ?? '';
}

// ─── Main parse ──────────────────────────────────────────────────────

const NS = {
  CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
  OPF: 'http://www.idpf.org/2007/opf',
  DC: 'http://purl.org/dc/elements/1.1/',
  NCX: 'http://www.daisy.org/z3986/2005/ncx/',
  XHTML: 'http://www.w3.org/1999/xhtml',
};

export async function parseEpub(blob: Blob): Promise<ParsedBook> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const files = unzipSync(buf);
  const fileMap = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    fileMap.set(name, bytes);
  }

  // 1. container.xml → OPF path
  const containerBytes = fileMap.get('META-INF/container.xml');
  if (!containerBytes) throw new Error('Missing META-INF/container.xml');
  const containerDoc = parseXml(strFromU8(containerBytes));
  const rootfile = containerDoc.getElementsByTagNameNS(NS.CONTAINER, 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('Missing rootfile full-path');

  // 2. OPF → manifest, spine, metadata
  const opfBytes = fileMap.get(opfPath);
  if (!opfBytes) throw new Error(`Missing OPF at ${opfPath}`);
  const opfDoc = parseXml(strFromU8(opfBytes));

  const metadata = parseMetadata(opfDoc);

  const manifestIdToPath = new Map<string, string>();
  const manifestIdToType = new Map<string, string>();
  const manifestIdToProperties = new Map<string, string>();
  const manifestItems = opfDoc.getElementsByTagNameNS(NS.OPF, 'item');
  for (const item of Array.from(manifestItems)) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') ?? '';
    const properties = item.getAttribute('properties') ?? '';
    if (!id || !href) continue;
    const path = resolvePath(opfPath, decodeURI(href));
    manifestIdToPath.set(id, path);
    manifestIdToType.set(id, mediaType);
    manifestIdToProperties.set(id, properties);
  }

  // 3. Build resources map (blob URLs for images, fonts; keep HTML/CSS bytes for inline processing)
  const resources = new Map<string, string>();
  const blobUrls: string[] = [];
  // path → cached CSS text after url() rewriting.
  const cssCache = new Map<string, string>();

  const registerBlob = (path: string, bytes: Uint8Array, mime: string): string => {
    // TS 5.7+ typed Uint8Array with ArrayBufferLike which Blob doesn't
    // accept directly; cast to BlobPart to bypass the stricter check —
    // the runtime signature has always accepted Uint8Array.
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    resources.set(path, url);
    return url;
  };

  // First pass: images, fonts, and other static binaries get blob URLs.
  for (const [id, path] of manifestIdToPath) {
    const mime = manifestIdToType.get(id) ?? mimeTypeForPath(path);
    const bytes = fileMap.get(path);
    if (!bytes) continue;
    if (mime.startsWith('image/') || mime.startsWith('font/') ||
        mime.startsWith('audio/') || mime.startsWith('video/')) {
      registerBlob(path, bytes, mime);
    }
  }

  // Second pass: CSS. Must rewrite url() refs to blob URLs from the first pass.
  for (const [id, path] of manifestIdToPath) {
    const mime = manifestIdToType.get(id) ?? mimeTypeForPath(path);
    if (mime !== 'text/css') continue;
    const bytes = fileMap.get(path);
    if (!bytes) continue;
    const rewritten = rewriteCssUrls(strFromU8(bytes), path, resources);
    cssCache.set(path, rewritten);
    // Also expose as blob URL for any @import or direct reference.
    registerBlob(path, new TextEncoder().encode(rewritten), 'text/css');
  }

  // 4. Spine
  const spineEl = opfDoc.getElementsByTagNameNS(NS.OPF, 'spine')[0];
  const itemrefs = spineEl ? Array.from(spineEl.getElementsByTagNameNS(NS.OPF, 'itemref')) : [];
  const spine: SpineItem[] = [];

  for (let i = 0; i < itemrefs.length; i++) {
    const itemref = itemrefs[i];
    if (!itemref) continue;
    const idref = itemref.getAttribute('idref');
    if (!idref) continue;
    const path = manifestIdToPath.get(idref);
    if (!path) continue;
    const linear = itemref.getAttribute('linear') !== 'no';
    const bytes = fileMap.get(path);
    if (!bytes) continue;

    const htmlText = strFromU8(bytes);
    const htmlDoc = parseXml(htmlText, 'application/xhtml+xml');

    // Sanitize: remove scripts, event handlers.
    sanitizeHtml(htmlDoc);

    // Collect stylesheets: inline <style> + <link rel="stylesheet">.
    const styles: string[] = [];
    const styleEls = htmlDoc.getElementsByTagName('style');
    for (const s of Array.from(styleEls)) {
      if (s.textContent) styles.push(rewriteCssUrls(s.textContent, path, resources));
    }
    const linkEls = htmlDoc.getElementsByTagName('link');
    for (const link of Array.from(linkEls)) {
      const rel = link.getAttribute('rel') ?? '';
      const href = link.getAttribute('href');
      if (rel.includes('stylesheet') && href) {
        const cssPath = resolvePath(path, decodeURI(href.split('#')[0] ?? ''));
        const cached = cssCache.get(cssPath);
        if (cached) styles.push(cached);
      }
    }

    // Rewrite img/image/src/href attrs to blob URLs.
    rewriteResourceAttrs(htmlDoc, path, resources);

    // Extract body HTML. EPUB sections may have no body (rare);
    // fall back to documentElement.
    const body = htmlDoc.querySelector('body');
    const bodyHtml = body ? body.innerHTML : htmlDoc.documentElement.innerHTML;

    const href = opfPathToHref(opfPath, path);
    spine.push({
      index: i,
      id: idref,
      path,
      href,
      bodyHtml,
      styles: styles.join('\n\n'),
      doc: htmlDoc,
      linear,
    });
  }

  // 5. TOC — EPUB3 nav.xhtml preferred, fall back to NCX.
  const toc = parseToc({
    opfDoc,
    opfPath,
    manifestIdToPath,
    manifestIdToProperties,
    fileMap,
  });

  const revoke = (): void => {
    for (const url of blobUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
  };

  return { metadata, spine, toc, resources, manifestIdToPath, opfPath, revoke };
}

// ─── Metadata ────────────────────────────────────────────────────────

function parseMetadata(opfDoc: Document): BookMetadata {
  const metaEl = opfDoc.getElementsByTagNameNS(NS.OPF, 'metadata')[0] ?? null;
  const title = elemTextNS(metaEl, NS.DC, 'title') || 'Untitled';
  const author = elemTextNS(metaEl, NS.DC, 'creator') || '';
  const language = elemTextNS(metaEl, NS.DC, 'language') || undefined;
  const identifier = elemTextNS(metaEl, NS.DC, 'identifier') || undefined;
  return { title, author, language, identifier };
}

// ─── TOC ─────────────────────────────────────────────────────────────

function parseToc(args: {
  opfDoc: Document;
  opfPath: string;
  manifestIdToPath: Map<string, string>;
  manifestIdToProperties: Map<string, string>;
  fileMap: Map<string, Uint8Array>;
}): TocItem[] {
  const { opfDoc, opfPath, manifestIdToPath, manifestIdToProperties, fileMap } = args;

  // EPUB3: item with properties="nav".
  for (const [id, props] of manifestIdToProperties) {
    if (!props.split(/\s+/).includes('nav')) continue;
    const path = manifestIdToPath.get(id);
    if (!path) continue;
    const bytes = fileMap.get(path);
    if (!bytes) continue;
    try {
      const doc = parseXml(strFromU8(bytes), 'application/xhtml+xml');
      const parsed = parseEpub3Nav(doc, path, opfPath);
      if (parsed.length) return parsed;
    } catch { /* fall through */ }
  }

  // EPUB2: NCX via spine toc attribute.
  const spineEl = opfDoc.getElementsByTagNameNS(NS.OPF, 'spine')[0];
  const ncxId = spineEl?.getAttribute('toc');
  if (ncxId) {
    const path = manifestIdToPath.get(ncxId);
    if (path) {
      const bytes = fileMap.get(path);
      if (bytes) {
        try {
          const doc = parseXml(strFromU8(bytes));
          return parseNcx(doc, path, opfPath);
        } catch { /* ignore */ }
      }
    }
  }

  return [];
}

function parseEpub3Nav(doc: Document, navPath: string, opfPath: string): TocItem[] {
  // Find <nav epub:type="toc"> then its <ol>.
  const navs = doc.getElementsByTagName('nav');
  let toc: Element | null = null;
  for (const nav of Array.from(navs)) {
    const type = nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? nav.getAttribute('epub:type') ?? '';
    if (type.split(/\s+/).includes('toc')) { toc = nav; break; }
  }
  if (!toc) return [];
  const ol = toc.querySelector('ol');
  if (!ol) return [];
  return readNavList(ol, 0, navPath, opfPath);
}

function readNavList(ol: Element, depth: number, navPath: string, opfPath: string): TocItem[] {
  const items: TocItem[] = [];
  for (const li of Array.from(ol.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const a = li.querySelector('a, span');
    const label = (a?.textContent ?? '').trim();
    const rawHref = (a && a.tagName.toLowerCase() === 'a')
      ? (a as HTMLAnchorElement).getAttribute('href') ?? ''
      : '';
    const href = rawHref
      ? opfPathToHref(opfPath, resolveHrefAgainst(navPath, rawHref))
      : '';
    const subOl = li.querySelector('ol');
    const item: TocItem = { label, href, depth };
    if (subOl) {
      item.subitems = readNavList(subOl, depth + 1, navPath, opfPath);
    }
    items.push(item);
  }
  return items;
}

function parseNcx(doc: Document, ncxPath: string, opfPath: string): TocItem[] {
  const navMap = doc.getElementsByTagNameNS(NS.NCX, 'navMap')[0];
  if (!navMap) return [];
  return readNcxPoints(navMap, 0, ncxPath, opfPath);
}

function readNcxPoints(parent: Element, depth: number, ncxPath: string, opfPath: string): TocItem[] {
  const out: TocItem[] = [];
  for (const pt of Array.from(parent.children)) {
    if (pt.localName !== 'navPoint') continue;
    const labelEl = pt.getElementsByTagNameNS(NS.NCX, 'text')[0];
    const content = pt.getElementsByTagNameNS(NS.NCX, 'content')[0];
    const label = labelEl?.textContent?.trim() ?? '';
    const src = content?.getAttribute('src') ?? '';
    const href = src ? opfPathToHref(opfPath, resolveHrefAgainst(ncxPath, src)) : '';
    const item: TocItem = { label, href, depth };
    const subs = readNcxPoints(pt, depth + 1, ncxPath, opfPath);
    if (subs.length) item.subitems = subs;
    out.push(item);
  }
  return out;
}

// ─── HTML sanitization & URL rewriting ───────────────────────────────

function sanitizeHtml(doc: Document): void {
  // Remove scripts and event handlers. EPUB3 technically allows JS, but
  // we don't execute book-provided scripts in this reader.
  for (const s of Array.from(doc.getElementsByTagName('script'))) s.remove();
  // Strip inline event handlers.
  const all = doc.getElementsByTagName('*');
  for (const el of Array.from(all)) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
      if (attr.name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function rewriteResourceAttrs(
  doc: Document,
  basePath: string,
  resources: Map<string, string>,
): void {
  const attrs: Array<[string, string[]]> = [
    ['img', ['src']],
    ['image', ['href', 'xlink:href']],
    ['source', ['src']],
    ['audio', ['src']],
    ['video', ['src', 'poster']],
    ['use', ['href', 'xlink:href']],
  ];
  for (const [tag, attrNames] of attrs) {
    const els = doc.getElementsByTagName(tag);
    for (const el of Array.from(els)) {
      for (const name of attrNames) {
        const val = el.getAttribute(name);
        if (!val) continue;
        const { path, fragment } = splitFragment(val);
        if (!path || isAbsoluteUrl(path)) continue;
        const resolved = resolvePath(basePath, decodeURI(path));
        const blobUrl = resources.get(resolved);
        if (blobUrl) {
          el.setAttribute(name, fragment ? `${blobUrl}#${fragment}` : blobUrl);
        }
      }
    }
  }
}

function rewriteCssUrls(css: string, basePath: string, resources: Map<string, string>): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, rawUrl) => {
    if (isAbsoluteUrl(rawUrl)) return m;
    const { path, fragment } = splitFragment(rawUrl);
    if (!path) return m;
    const resolved = resolvePath(basePath, decodeURI(path));
    const blobUrl = resources.get(resolved);
    if (!blobUrl) return m;
    const out = fragment ? `${blobUrl}#${fragment}` : blobUrl;
    return `url("${out}")`;
  });
}

function isAbsoluteUrl(u: string): boolean {
  return /^(blob:|data:|https?:|file:)/i.test(u);
}

// ─── Href utilities ──────────────────────────────────────────────────

/**
 * Translate an absolute EPUB path back to a TOC-style href (relative to
 * the OPF directory). Used so TOC hrefs and spine hrefs use the same
 * coordinate system.
 */
function opfPathToHref(opfPath: string, targetPath: string): string {
  const opfDir = opfPath.split('/').slice(0, -1).join('/');
  if (!opfDir) return targetPath;
  if (targetPath.startsWith(opfDir + '/')) return targetPath.slice(opfDir.length + 1);
  return targetPath;
}

function resolveHrefAgainst(fromPath: string, href: string): string {
  const { path, fragment } = splitFragment(href);
  const resolved = resolvePath(fromPath, decodeURI(path));
  return fragment ? `${resolved}#${fragment}` : resolved;
}
