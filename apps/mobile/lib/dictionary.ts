/**
 * Dictionary lookup. Primary source is the self-hosted dictionary
 * endpoint on the readr server (Wiktionary + WordNet, ~1M entries).
 * Falls back to a bundled offline dictionary (~108k words) when the
 * server is unreachable or not configured.
 *
 * Bundled data lives in apps/mobile/assets/dictionary/<letter>.json.
 * Metro bundles the require() calls directly into the JS bundle.
 */
import { getServerUrl } from "./api";

interface DictEntry {
  d: string;
  p?: string;
}
type LetterMap = Record<string, DictEntry>;

/**
 * Metro inlines these require() calls as static JSON into the JS
 * bundle. Each resolves to the parsed object directly — no async
 * loading needed. We use a function so they're only evaluated on
 * first access (Metro resolves them eagerly but the object is
 * already in memory).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const LETTER_DATA: Record<string, LetterMap> = {
  a: require("../assets/dictionary/a.json"),
  b: require("../assets/dictionary/b.json"),
  c: require("../assets/dictionary/c.json"),
  d: require("../assets/dictionary/d.json"),
  e: require("../assets/dictionary/e.json"),
  f: require("../assets/dictionary/f.json"),
  g: require("../assets/dictionary/g.json"),
  h: require("../assets/dictionary/h.json"),
  i: require("../assets/dictionary/i.json"),
  j: require("../assets/dictionary/j.json"),
  k: require("../assets/dictionary/k.json"),
  l: require("../assets/dictionary/l.json"),
  m: require("../assets/dictionary/m.json"),
  n: require("../assets/dictionary/n.json"),
  o: require("../assets/dictionary/o.json"),
  p: require("../assets/dictionary/p.json"),
  q: require("../assets/dictionary/q.json"),
  r: require("../assets/dictionary/r.json"),
  s: require("../assets/dictionary/s.json"),
  t: require("../assets/dictionary/t.json"),
  u: require("../assets/dictionary/u.json"),
  v: require("../assets/dictionary/v.json"),
  w: require("../assets/dictionary/w.json"),
  x: require("../assets/dictionary/x.json"),
  y: require("../assets/dictionary/y.json"),
  z: require("../assets/dictionary/z.json"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

async function loadLetter(letter: string): Promise<LetterMap | null> {
  return LETTER_DATA[letter] ?? null;
}

export interface Definition {
  definition: string;
  partOfSpeech?: string;
  pronunciation?: string;
}

export interface LookupResult {
  word: string;
  /** Primary definition (first one). */
  definition: string;
  partOfSpeech?: string;
  /** All definitions grouped by part of speech. */
  definitions: Definition[];
}

/**
 * Normalize a raw selection into an ordered list of candidate forms to
 * try against the dictionary. Case is preserved and expanded into
 * variants because dict entries are stored in a single canonical form:
 * "apple" but "German", "god" but "ASAP". Real-world selections are
 * also noisy — curly quotes, unicode dashes, attached punctuation,
 * soft hyphens from line wraps, etc.
 */
function candidateWords(raw: string): string[] {
  const normalized = raw
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u00ad/g, "");

  // Strip leading/trailing non-letter characters (keeps internal
  // hyphens and apostrophes — valid in entries like "well-being" or
  // "don't").
  const stripEdges = (s: string) => s.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");

  const bases: string[] = [];
  const seenBase = new Set<string>();
  const pushBase = (s: string) => {
    if (s && !seenBase.has(s)) {
      seenBase.add(s);
      bases.push(s);
    }
  };

  // 1. Whole selection as one token (handles "well-being", "ice cream").
  pushBase(stripEdges(normalized.replace(/\s+/g, " ").trim()));
  // 2. Each whitespace-delimited word individually.
  for (const part of normalized.split(/\s+/)) {
    pushBase(stripEdges(part));
  }
  // 3. Internal-punctuation variants (hyphens/apostrophes stripped).
  for (const b of [...bases]) {
    if (b.includes("-")) pushBase(b.replace(/-/g, ""));
    if (b.includes("'")) pushBase(b.replace(/'/g, ""));
  }

  // Expand each base into case variants: as-selected, lowercase,
  // Title case, and UPPERCASE. Dict has only one canonical form per
  // word, so we try all four to cover "German", "ASAP", "apple", etc.
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (s && !seen.has(s) && /^[A-Za-z]/.test(s)) {
      seen.add(s);
      variants.push(s);
    }
  };
  for (const b of bases) {
    push(b);
    push(b.toLowerCase());
    push(b[0].toUpperCase() + b.slice(1).toLowerCase());
    push(b.toUpperCase());
  }
  return variants;
}

/**
 * Bounded Levenshtein edit distance. Bails out early when the current
 * row's minimum already exceeds `max`, so worst-case work is O(n*max)
 * instead of O(n*m) for the common "not close enough" rejection path.
 */
function editDistance(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb];
}

/**
 * Scan a letter file for the closest dictionary entry to `query` by
 * lowercased edit distance. Returns the canonical key of the best
 * match under `maxDist`, or null.
 */
function fuzzyMatch(
  dict: LetterMap,
  query: string,
  maxDist: number,
): string | null {
  const q = query.toLowerCase();
  let best: { key: string; dist: number } | null = null;
  for (const key of Object.keys(dict)) {
    const keyLc = key.toLowerCase();
    const allowed = best ? Math.min(maxDist, best.dist - 1) : maxDist;
    if (allowed < 0) continue;
    const dist = editDistance(q, keyLc, allowed);
    if (dist <= allowed) {
      best = { key, dist };
      if (dist === 0) return key;
    }
  }
  return best?.key ?? null;
}

/**
 * Hit the self-hosted dictionary endpoint on the readr server.
 * Falls back to the bundled offline dictionary on network failure,
 * 404, or when no server URL is configured (e.g. before login).
 */
async function lookupServer(word: string): Promise<LookupResult | null> {
  try {
    const serverUrl = await getServerUrl();
    if (!serverUrl) return null;
    const resp = await fetch(
      `${serverUrl}/api/dictionary/${encodeURIComponent(word)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.word || !Array.isArray(data.entries)) return null;
    const defs: Definition[] = [];
    for (const entry of data.entries) {
      const pos = entry.pos as string | undefined;
      const pron = entry.pronunciation as string | undefined;
      for (const d of entry.definitions ?? []) {
        defs.push({ definition: d.definition, partOfSpeech: pos, pronunciation: pron });
      }
    }
    if (defs.length === 0) return null;
    return {
      word: data.word,
      definition: defs[0].definition,
      partOfSpeech: defs[0].partOfSpeech,
      definitions: defs,
    };
  } catch {
    return null;
  }
}

/**
 * Look up a word. Tries the self-hosted server first for rich
 * multi-definition results (Wiktionary + WordNet), falls back to the
 * bundled offline dictionary on failure. The server handles its own
 * fuzzy matching, so we send the raw selection directly; the bundled
 * fallback still does client-side candidate generation and stemming.
 */
export async function lookupWord(raw: string): Promise<LookupResult | null> {
  // Try the self-hosted server first — it has ~1M entries, multiple
  // definitions, pronunciations, and its own fuzzy matching.
  const server = await lookupServer(raw.trim());
  if (server) return server;

  // Offline fallback: bundled wordset dictionary (~108k single-
  // definition entries with client-side stemming and fuzzy matching).
  const candidates = candidateWords(raw);
  if (candidates.length === 0) return null;

  for (const cand of candidates) {
    // Dict files are keyed a-z on the lowercased first char, but keys
    // within a file preserve the entry's canonical case.
    const letter = cand[0].toLowerCase();
    const dict = await loadLetter(letter);
    if (!dict) continue;

    const direct = dict[cand];
    if (direct) {
      return { word: cand, definition: direct.d, partOfSpeech: direct.p, definitions: [{ definition: direct.d, partOfSpeech: direct.p }] };
    }

    // Strip common suffixes to catch simple inflections.
    const stems = [
      cand.replace(/ies$/, "y"),
      cand.replace(/es$/, ""),
      cand.replace(/s$/, ""),
      cand.replace(/ing$/, ""),
      cand.replace(/ing$/, "e"),
      cand.replace(/ed$/, ""),
      cand.replace(/ed$/, "e"),
      cand.replace(/ly$/, ""),
    ];
    for (const stem of stems) {
      if (stem === cand) continue;
      const hit = dict[stem];
      if (hit) return { word: stem, definition: hit.d, partOfSpeech: hit.p, definitions: [{ definition: hit.d, partOfSpeech: hit.p }] };
    }
  }

  // Fuzzy fallback. Use the first candidate (usually the full
  // selection or first word) as the query. Threshold scales with
  // length so we don't match garbage for short words.
  const primary = candidates[0];
  if (primary.length >= 3) {
    const letter = primary[0].toLowerCase();
    const dict = await loadLetter(letter);
    if (dict) {
      const maxDist = primary.length <= 5 ? 1 : primary.length <= 10 ? 2 : 3;
      const key = fuzzyMatch(dict, primary, maxDist);
      if (key) {
        const hit = dict[key];
        return { word: key, definition: hit.d, partOfSpeech: hit.p, definitions: [{ definition: hit.d, partOfSpeech: hit.p }] };
      }
    }
  }

  return null;
}
