import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system";

/**
 * Offline English dictionary. The wordset-dictionary data has been
 * compacted into apps/mobile/assets/dictionary/<letter>.json. Each file
 * is { word: { d: definition, p: partOfSpeech } }. We lazy-load the
 * letter file for the first character of the looked-up word and cache
 * it in memory so subsequent lookups in the same letter are instant.
 *
 * Total bundled size: ~9 MB across 27 files, ~108,000 words.
 */

interface DictEntry {
  d: string;
  p?: string;
}
type LetterMap = Record<string, DictEntry>;

const cache = new Map<string, LetterMap>();
const loading = new Map<string, Promise<LetterMap | null>>();

/**
 * Metro bundles require() static JSONs into the JS bundle, which is
 * exactly what we want — but imports can only resolve literal paths.
 * Map each letter to its module ref up front.
 */
const LETTER_ASSETS: Record<string, number> = {
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

async function loadLetter(letter: string): Promise<LetterMap | null> {
  if (cache.has(letter)) return cache.get(letter)!;
  const existing = loading.get(letter);
  if (existing) return existing;

  const module = LETTER_ASSETS[letter];
  if (module == null) return null;

  const promise = (async () => {
    try {
      const asset = Asset.fromModule(module);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      const raw = await FileSystem.readAsStringAsync(uri);
      const parsed = JSON.parse(raw) as LetterMap;
      cache.set(letter, parsed);
      return parsed;
    } catch (err) {
      console.warn(`dictionary letter ${letter} failed to load:`, err);
      return null;
    } finally {
      loading.delete(letter);
    }
  })();
  loading.set(letter, promise);
  return promise;
}

export interface LookupResult {
  word: string;
  definition: string;
  partOfSpeech?: string;
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
 * Look up a word in the offline dictionary. Handles case, punctuation,
 * hyphenation, apostrophes, and common inflections. Falls back to a
 * bounded fuzzy search on the first-letter file if no exact/stem match
 * is found — useful for typos and OCR artifacts. Returns null if no
 * reasonable match exists.
 */
export async function lookupWord(raw: string): Promise<LookupResult | null> {
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
      return { word: cand, definition: direct.d, partOfSpeech: direct.p };
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
      if (hit) return { word: stem, definition: hit.d, partOfSpeech: hit.p };
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
        return { word: key, definition: hit.d, partOfSpeech: hit.p };
      }
    }
  }

  return null;
}
