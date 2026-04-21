/// <reference lib="dom" />
/**
 * Annotations — highlights and note markers rendered as SVG overlays
 * that live inside each section element so they scroll/paginate with
 * content naturally.
 */

import type { RenderHost } from './host';
import { resolveCfi } from './cfi';

type NoteType = 'typed' | 'handwritten';

export interface HighlightRecord {
  cfi: string;
  color: string;
}
export interface NoteRecord {
  cfi: string;
  noteType: NoteType;
}

interface SectionOverlay {
  el: SVGSVGElement;
  /** annotation key (cfi) → group element, so add/remove is O(1). */
  groups: Map<string, SVGElement>;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#fef08a',
  green: '#bbf7d0',
  blue: '#bae6fd',
  pink: '#fbcfe8',
  purple: '#e9d5ff',
};

export class AnnotationLayer {
  private host: RenderHost;
  private overlays: Map<number, SectionOverlay> = new Map();
  /** cfi → record. Used so we can replay after a relayout. */
  private highlights = new Map<string, HighlightRecord>();
  private notes = new Map<string, NoteRecord>();
  /** cfi → live range for hit testing on tap. Rects computed lazily
   * (per-tap) because viewport-relative rects drift with every scroll
   * and page turn, so we can't cache them at draw time. */
  private hitRanges: Array<{ cfi: string; kind: 'highlight' | 'note'; noteType?: NoteType; range: Range; sectionIndex: number }> = [];

  constructor(host: RenderHost) {
    this.host = host;
    this.ensureOverlays();
    // Re-render on resize (e.g. orientation change or keyboard appearance).
    window.addEventListener('resize', () => this.rerenderAll());
    // When a lazy-mounted section becomes real content, any highlights
    // or notes in that section couldn't resolve before (the sanitized
    // doc existed but the LIVE DOM didn't). Replay them now.
    host.setSectionMaterializedHandler((index) => {
      this.ensureOverlays();
      this.replayForSection(index);
    });
  }

  /** Draw any stored highlights/notes whose CFI resolves into the
   *  given section. Idempotent: removes any existing group for the
   *  cfi first via the draw methods. */
  private replayForSection(sectionIndex: number): void {
    for (const [cfi, rec] of this.highlights) {
      const resolved = tryResolveSection(cfi, this.host);
      if (resolved === sectionIndex) this.drawHighlight(cfi, rec.color);
    }
    for (const [cfi, rec] of this.notes) {
      const resolved = tryResolveSection(cfi, this.host);
      if (resolved === sectionIndex) this.drawNote(cfi, rec.noteType);
    }
  }

  /** Tear down and rebuild all overlay SVGs from scratch. */
  rerenderAll(): void {
    // Clear existing groups.
    for (const ov of this.overlays.values()) {
      ov.groups.clear();
      while (ov.el.firstChild) ov.el.removeChild(ov.el.firstChild);
    }
    this.hitRanges = [];
    for (const [cfi, rec] of this.highlights) this.drawHighlight(cfi, rec.color);
    for (const [cfi, rec] of this.notes) this.drawNote(cfi, rec.noteType);
  }

  private ensureOverlays(): void {
    for (let i = 0; i < this.host.spineLength; i++) {
      const sec = this.host.sectionElement(i);
      if (!sec) continue;
      if (this.overlays.has(i)) continue;
      // Make sure the section is a positioning root so the SVG can be
      // absolutely positioned relative to it.
      if (getComputedStyle(sec).position === 'static') {
        sec.style.position = 'relative';
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
      svg.setAttribute('class', 'readr-annot-layer');
      svg.style.position = 'absolute';
      svg.style.top = '0';
      svg.style.left = '0';
      svg.style.width = '100%';
      svg.style.height = '100%';
      svg.style.pointerEvents = 'none';
      svg.style.zIndex = '2';
      sec.appendChild(svg);
      this.overlays.set(i, { el: svg, groups: new Map() });
    }
  }

  addHighlight(cfi: string, color: string): void {
    this.highlights.set(cfi, { cfi, color });
    this.drawHighlight(cfi, color);
  }

  removeHighlight(cfi: string): void {
    this.highlights.delete(cfi);
    this.removeAnnotation(cfi);
  }

  addNote(cfi: string, noteType: NoteType): void {
    this.notes.set(cfi, { cfi, noteType });
    this.drawNote(cfi, noteType);
  }

  removeNote(cfi: string): void {
    this.notes.delete(cfi);
    this.removeAnnotation(cfi);
  }

  private removeAnnotation(cfi: string): void {
    for (const ov of this.overlays.values()) {
      const g = ov.groups.get(cfi);
      if (g) {
        g.remove();
        ov.groups.delete(cfi);
      }
    }
    this.hitRanges = this.hitRanges.filter((r) => r.cfi !== cfi);
  }

  /** Returns { cfi, kind } if the point hits an annotation; else null.
   *  Recomputes each range's client rects on every call so scroll /
   *  page turns don't stale the cache. */
  hitTest(x: number, y: number): { cfi: string; kind: 'highlight' | 'note'; noteType?: NoteType; rect: DOMRect } | null {
    for (const h of this.hitRanges) {
      const rects = h.range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return { cfi: h.cfi, kind: h.kind, noteType: h.noteType, rect: r };
        }
      }
    }
    return null;
  }

  private drawHighlight(cfi: string, color: string): void {
    const sections = this.host.book.spine.map((s) => ({ index: s.index, doc: s.doc }));
    const resolved = resolveCfi(cfi, sections);
    if (!resolved) return;
    const { sectionIndex, range: sourceRange } = resolved;
    if (!sourceRange) return;
    // The resolved range points into the SANITIZED section doc, not the
    // mounted copy inside shadow DOM. We reconstruct the equivalent
    // range inside the shadow-mounted section element using the same
    // path walk.
    const liveRange = this.liveRangeFromSourceRange(sectionIndex, sourceRange);
    if (!liveRange) return;
    const sectionEl = this.host.sectionElement(sectionIndex);
    const ov = this.overlays.get(sectionIndex);
    if (!ov || !sectionEl) return;
    const rects = Array.from(liveRange.getClientRects());
    const secRect = sectionEl.getBoundingClientRect();
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGElement;
    g.setAttribute('data-cfi', cfi);
    for (const r of rects) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(r.left - secRect.left));
      rect.setAttribute('y', String(r.top - secRect.top));
      rect.setAttribute('width', String(r.width));
      rect.setAttribute('height', String(r.height));
      rect.setAttribute('fill', HIGHLIGHT_COLORS[color] ?? color);
      rect.setAttribute('fill-opacity', '0.45');
      g.appendChild(rect);
    }
    this.hitRanges.push({ cfi, kind: 'highlight', range: liveRange, sectionIndex });
    ov.el.appendChild(g);
    const prev = ov.groups.get(cfi);
    if (prev) prev.remove();
    ov.groups.set(cfi, g);
  }

  private drawNote(cfi: string, noteType: NoteType): void {
    const sections = this.host.book.spine.map((s) => ({ index: s.index, doc: s.doc }));
    const resolved = resolveCfi(cfi, sections);
    if (!resolved) return;
    const { sectionIndex, range: sourceRange } = resolved;
    if (!sourceRange) return;
    const liveRange = this.liveRangeFromSourceRange(sectionIndex, sourceRange);
    if (!liveRange) return;
    const sectionEl = this.host.sectionElement(sectionIndex);
    const ov = this.overlays.get(sectionIndex);
    if (!ov || !sectionEl) return;
    const rects = Array.from(liveRange.getClientRects());
    const secRect = sectionEl.getBoundingClientRect();
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGElement;
    g.setAttribute('data-cfi', cfi);
    g.setAttribute('data-note-type', noteType);
    const color = noteType === 'handwritten' ? '#6366f1' : '#d97706';
    for (const r of rects) {
      // Squiggly underline: draw a wavy path along the baseline.
      const baseY = r.top - secRect.top + r.height - 2;
      const startX = r.left - secRect.left;
      const endX = r.left + r.width - secRect.left;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', squigglyPath(startX, endX, baseY));
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('fill', 'none');
      g.appendChild(path);
    }
    this.hitRanges.push({ cfi, kind: 'note', noteType, range: liveRange, sectionIndex });
    ov.el.appendChild(g);
    const prev = ov.groups.get(cfi);
    if (prev) prev.remove();
    ov.groups.set(cfi, g);
  }

  /**
   * Build a range inside the rendered (shadow-DOM) section matching a
   * range that was resolved against the book's sanitized Document. We
   * do this by computing the node path from the section root in the
   * source doc, then walking the same path in the live DOM.
   */
  private liveRangeFromSourceRange(sectionIndex: number, source: Range): Range | null {
    const sourceDoc = this.host.sectionDoc(sectionIndex);
    const liveSection = this.host.sectionElement(sectionIndex);
    if (!sourceDoc || !liveSection) return null;
    const sourceRoot = sourceDoc.body ?? sourceDoc.documentElement;
    if (!sourceRoot) return null;
    const startPath = pathFrom(sourceRoot, source.startContainer);
    const endPath = pathFrom(sourceRoot, source.endContainer);
    if (!startPath || !endPath) return null;
    const startNode = walkPath(liveSection, startPath);
    const endNode = walkPath(liveSection, endPath);
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, source.startOffset);
      range.setEnd(endNode, source.endOffset);
      return range;
    } catch {
      return null;
    }
  }
}

// Compute an array of child indices from root to descendant.
function pathFrom(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  let cur: Node | null = node;
  while (cur && cur !== root) {
    const p: Node | null = cur.parentNode;
    if (!p) return null;
    const idx = Array.prototype.indexOf.call(p.childNodes, cur);
    if (idx < 0) return null;
    path.unshift(idx);
    cur = p;
  }
  return cur === root ? path : null;
}

function walkPath(root: Node, path: number[]): Node | null {
  let cur: Node | null = root;
  for (const i of path) {
    if (!cur) return null;
    cur = cur.childNodes[i] ?? null;
  }
  return cur;
}

/** Returns the section index a CFI resolves to, or null if un-parseable.
 *  Fast path: pick the spine step without recomputing the range. */
function tryResolveSection(cfi: string, host: RenderHost): number | null {
  const sections = host.book.spine.map((s) => ({ index: s.index, doc: s.doc }));
  const r = resolveCfi(cfi, sections);
  return r ? r.sectionIndex : null;
}

function squigglyPath(x1: number, x2: number, y: number): string {
  const amp = 1.5;
  const step = 4;
  let d = `M ${x1} ${y}`;
  let up = true;
  for (let x = x1 + step; x <= x2; x += step) {
    d += ` Q ${x - step / 2} ${up ? y - amp : y + amp} ${x} ${y}`;
    up = !up;
  }
  return d;
}
