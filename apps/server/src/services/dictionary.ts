/**
 * Self-hosted dictionary backed by a SQLite database built from
 * English Wiktionary + WordNet data. The DB is pre-built by
 * `scripts/build-dictionary.mjs` and loaded read-only at startup.
 *
 * Lookups use COLLATE NOCASE for case-insensitive exact match, then
 * fall back to LIKE prefix match, then to a server-side Levenshtein
 * fuzzy search if no exact match is found. The original casing is
 * preserved in the `word` column so proper nouns ("Einstein"),
 * acronyms ("NASA"), etc. display correctly in the response.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";

export interface Definition {
  definition: string;
  example?: string;
}

export interface WordEntry {
  word: string;
  pos: string | null;
  pronunciation: string | null;
  definitions: Definition[];
}

export interface LookupResult {
  word: string;
  entries: WordEntry[];
}

let db: Database.Database | null = null;

// import.meta.dirname can be undefined under tsx ESM, so derive from
// import.meta.url which is always set.
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DB_PATH = path.resolve(__dirname, "../../data/dictionary.db");

function getDb(): Database.Database | null {
  if (db) return db;
  if (!existsSync(DB_PATH)) {
    console.warn(
      `[dictionary] Database not found at ${DB_PATH}. Run 'node apps/server/scripts/build-dictionary.mjs' to build it.`,
    );
    return null;
  }
  db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("cache_size = -64000"); // 64 MB read cache
  console.log(`[dictionary] Loaded ${DB_PATH}`);
  return db;
}

// ── Levenshtein (bounded) ───────────────────────────────────────────

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
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// ── Result builder ──────────────────────────────────────────────────

interface RawRow {
  id: string;
  word: string;
  pos: string | null;
  pronunciation: string | null;
  definition: string;
  example: string | null;
}

function buildResult(rows: RawRow[]): LookupResult | null {
  if (rows.length === 0) return null;

  const entryMap = new Map<string, WordEntry>();
  const displayWord = rows[0].word;

  for (const row of rows) {
    let entry = entryMap.get(row.id);
    if (!entry) {
      entry = {
        word: row.word,
        pos: row.pos,
        pronunciation: row.pronunciation,
        definitions: [],
      };
      entryMap.set(row.id, entry);
    }
    entry.definitions.push({
      definition: row.definition,
      ...(row.example ? { example: row.example } : {}),
    });
  }

  return { word: displayWord, entries: Array.from(entryMap.values()) };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Look up a word with a three-tier strategy:
 * 1. Exact match (case-insensitive via COLLATE NOCASE)
 * 2. Common inflection stems (-s, -es, -ed, -ing, -ly, -ies)
 * 3. Fuzzy Levenshtein match on words starting with the same letter
 */
export function lookup(raw: string): LookupResult | null {
  const conn = getDb();
  if (!conn) return null;

  const query = raw
    .trim()
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u00ad/g, "");
  if (!query) return null;

  const selectSql = `
    SELECT w.id, w.word, w.pos, w.pronunciation,
           d.definition, d.example
    FROM words w
    JOIN definitions d ON d.word_id = w.id
    WHERE w.word = ? COLLATE NOCASE
    ORDER BY w.pos, w.rowid
  `;
  const selectStmt = conn.prepare(selectSql);

  // 1. Exact match
  const exact = selectStmt.all(query) as RawRow[];
  if (exact.length > 0) return buildResult(exact);

  // 2. Inflection stems
  const stems = new Set<string>();
  const q = query.toLowerCase();
  if (q.endsWith("ies")) stems.add(q.slice(0, -3) + "y");
  if (q.endsWith("es")) stems.add(q.slice(0, -2));
  if (q.endsWith("s")) stems.add(q.slice(0, -1));
  if (q.endsWith("ing")) {
    stems.add(q.slice(0, -3));
    stems.add(q.slice(0, -3) + "e");
  }
  if (q.endsWith("ed")) {
    stems.add(q.slice(0, -2));
    stems.add(q.slice(0, -1));
    stems.add(q.slice(0, -2) + "e");
  }
  if (q.endsWith("ly")) stems.add(q.slice(0, -2));
  if (q.endsWith("er")) {
    stems.add(q.slice(0, -2));
    stems.add(q.slice(0, -1));
  }
  if (q.endsWith("est")) {
    stems.add(q.slice(0, -3));
    stems.add(q.slice(0, -3) + "e");
  }
  stems.delete(q);

  for (const stem of stems) {
    if (stem.length < 2) continue;
    const rows = selectStmt.all(stem) as RawRow[];
    if (rows.length > 0) return buildResult(rows);
  }

  // 3. Fuzzy match — grab candidate words starting with the same
  //    letter(s) and pick the best Levenshtein match. Limit the
  //    candidate set to keep it fast.
  if (q.length >= 3) {
    const prefix = q.substring(0, 2);
    const maxDist = q.length <= 5 ? 1 : q.length <= 10 ? 2 : 3;
    const candidates = conn
      .prepare(
        `SELECT DISTINCT word FROM words
         WHERE word LIKE ? COLLATE NOCASE
         LIMIT 5000`,
      )
      .all(`${prefix}%`) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;
    for (const { word } of candidates) {
      const dist = editDistance(q, word.toLowerCase(), bestDist - 1);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = word;
        if (dist === 0) break;
      }
    }

    if (bestWord) {
      const rows = selectStmt.all(bestWord) as RawRow[];
      if (rows.length > 0) return buildResult(rows);
    }
  }

  return null;
}

/** Returns true if the dictionary DB is available. */
export function isAvailable(): boolean {
  return getDb() !== null;
}
