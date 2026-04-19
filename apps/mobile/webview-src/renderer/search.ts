/// <reference lib="dom" />
/**
 * Full-text search — scans the sanitized section DOMs for matches,
 * returns CFI + excerpt for each hit.
 */

import type { ParsedBook } from './parser';
import { rangeToCfi } from './cfi';

export interface SearchResult {
  cfi: string;
  excerpt: string;
  section: string;
}

export async function searchBook(
  book: ParsedBook,
  query: string,
  options: { maxResults?: number } = {},
): Promise<SearchResult[]> {
  const max = options.maxResults ?? 100;
  const q = query.toLowerCase();
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const section of book.spine) {
    const doc = section.doc;
    const body = doc.body ?? doc.documentElement;
    if (!body) continue;
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any;
    // eslint-disable-next-line no-cond-assign
    while ((node = walker.nextNode())) {
      const text = (node as Text).data;
      if (!text) continue;
      const hay = text.toLowerCase();
      let idx = hay.indexOf(q);
      while (idx >= 0) {
        const range = doc.createRange();
        try {
          range.setStart(node, idx);
          range.setEnd(node, idx + q.length);
        } catch {
          break;
        }
        const cfi = rangeToCfi(section.index, range);
        const excerpt = buildExcerpt(text, idx, idx + q.length);
        results.push({ cfi, excerpt, section: section.href });
        if (results.length >= max) return results;
        idx = hay.indexOf(q, idx + q.length);
      }
    }
  }
  return results;
}

function buildExcerpt(text: string, start: number, end: number, ctx = 40): string {
  const s = Math.max(0, start - ctx);
  const e = Math.min(text.length, end + ctx);
  const prefix = s > 0 ? '…' : '';
  const suffix = e < text.length ? '…' : '';
  return (prefix + text.slice(s, e).replace(/\s+/g, ' ').trim() + suffix);
}
