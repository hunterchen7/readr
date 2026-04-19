/// <reference lib="dom" />
/**
 * CFI interop — wraps foliate's epubcfi.js for parse/serialize. Existing
 * user data (bookmarks, highlights, notes) stores CFI strings, so the
 * new renderer has to round-trip those strings to keep prior data
 * resolvable after the refactor.
 *
 * We keep only foliate's CFI module; everything else is our own.
 */

// @ts-expect-error — foliate-js has no published types; import is pure ESM.
import * as CFI from 'foliate-js/epubcfi.js';

export interface ResolvedPosition {
  /** Spine index of the containing section. */
  sectionIndex: number;
  /** A live range inside that section's document, if resolvable. */
  range: Range | null;
}

/** Build a CFI for a DOM range inside a given section. */
export function rangeToCfi(sectionIndex: number, range: Range): string {
  try {
    // foliate's fromRange returns the local (in-doc) CFI without any
    // spine prefix — we prepend via joinIndir so the result is a full
    // package-level CFI the resolver can round-trip.
    const localCfi: string = CFI.fromRange(range);
    const spineCfi: string = CFI.fake.fromIndex(sectionIndex);
    return CFI.joinIndir(spineCfi, localCfi);
  } catch {
    return '';
  }
}

/** Parse a CFI string and find the (section, range) it points to. */
export function resolveCfi(
  cfi: string,
  sections: Array<{ index: number; doc: Document }>,
): ResolvedPosition | null {
  try {
    // parse() returns either an array of indirection part-arrays, or a
    // { parent, start, end } for ranges. Normalize to indirections.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = CFI.parse(cfi);
    const indirections: Array<Array<{ index: number; offset?: number; id?: string }>> =
      Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.parent) ? parsed.parent : []);
    if (indirections.length < 1) return null;

    // First indirection points at the spine. "/6/N" — N = (idx+1)*2.
    const spineSteps = indirections[0] ?? [];
    const spineStep = spineSteps[spineSteps.length - 1];
    if (!spineStep || typeof spineStep.index !== 'number') return null;
    const sectionIndex = Math.max(0, Math.floor(spineStep.index / 2) - 1);

    const section = sections.find((s) => s.index === sectionIndex);
    if (!section) return { sectionIndex, range: null };

    // Remaining indirections target the in-doc position. Pass the
    // sub-indirections *plus* the range tails (if any) to toRange.
    if (indirections.length === 1) {
      // Spine-only CFI — no in-doc position. Place range at section start.
      const range = section.doc.createRange();
      range.setStart(section.doc.body ?? section.doc.documentElement, 0);
      range.collapse(true);
      return { sectionIndex, range };
    }

    const localIndir = indirections.slice(1);
    // toRange expects an "indirection array" shape. Wrap either as
    // a plain array (for collapsed) or mimic { parent, start, end }.
    try {
      let localParts: unknown;
      if (!Array.isArray(parsed)) {
        // Range CFI — build a range-shaped local by stripping the spine
        // indirection from each of parent/start/end.
        localParts = {
          parent: (parsed.parent ?? []).slice(1),
          start: (parsed.start ?? []),
          end: (parsed.end ?? []),
        };
      } else {
        localParts = localIndir;
      }
      const range: Range = CFI.toRange(section.doc, localParts);
      return { sectionIndex, range: range ?? null };
    } catch {
      return { sectionIndex, range: null };
    }
  } catch {
    return null;
  }
}

/** Test whether a string looks like a CFI. */
export function isCfi(s: string | null | undefined): boolean {
  return !!s && /^epubcfi\(/.test(s);
}

/** Build a spine-only CFI pointing at a section with no in-doc position. */
export function sectionCfi(sectionIndex: number): string {
  return CFI.fake.fromIndex(sectionIndex);
}
