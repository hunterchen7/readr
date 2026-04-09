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
 * Look up a word in the offline dictionary. Case/space/punctuation are
 * normalized. Returns null if the word isn't known (in which case the
 * caller can fall back to the online lookup providers in the context
 * menu).
 */
export async function lookupWord(raw: string): Promise<LookupResult | null> {
  const cleaned = raw
    .trim()
    .toLowerCase()
    // Strip leading/trailing punctuation that commonly comes with selections
    .replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (!cleaned) return null;

  const letter = cleaned[0];
  const dict = await loadLetter(letter);
  if (!dict) return null;

  // Direct hit
  const direct = dict[cleaned];
  if (direct) {
    return { word: cleaned, definition: direct.d, partOfSpeech: direct.p };
  }
  // Strip common suffixes to catch simple inflections (plurals, -ing, -ed).
  const stems = [
    cleaned.replace(/ies$/, "y"),
    cleaned.replace(/es$/, ""),
    cleaned.replace(/s$/, ""),
    cleaned.replace(/ing$/, ""),
    cleaned.replace(/ing$/, "e"),
    cleaned.replace(/ed$/, ""),
    cleaned.replace(/ed$/, "e"),
    cleaned.replace(/ly$/, ""),
  ];
  for (const stem of stems) {
    if (stem === cleaned) continue;
    const hit = dict[stem];
    if (hit) return { word: stem, definition: hit.d, partOfSpeech: hit.p };
  }
  return null;
}
