#!/usr/bin/env node
/**
 * Build the self-hosted dictionary SQLite database.
 *
 * Sources:
 *   1. English Wiktionary extract from kaikki.org (~1M entries)
 *      — comprehensive: every English word, proper nouns, historical
 *        figures, places, slang, technical terms, pronunciations.
 *   2. Princeton WordNet 3.1 (via wordnet-db npm package, ~155k lemmas)
 *      — fills structural gaps and adds synset-level definitions that
 *        Wiktionary sometimes splits across sub-senses.
 *
 * Output: apps/server/data/dictionary.db (~150-250 MB SQLite)
 *
 * Schema:
 *   words(id TEXT PK, word TEXT, pos TEXT, pronunciation TEXT)
 *   definitions(id TEXT PK, word_id TEXT FK, definition TEXT, example TEXT)
 *   + index on words(word_lower) for fast lookups
 *
 * Usage:
 *   node apps/server/scripts/build-dictionary.mjs
 *
 * Requires: Node 18+, ~2 GB free RAM during build, internet access for
 * the Wiktionary download (WordNet is bundled via npm).
 */
import { createWriteStream, existsSync, unlinkSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const WIKTIONARY_URL =
  "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz";

const OUT_DIR = path.resolve(import.meta.dirname, "../data");
const DB_PATH = path.join(OUT_DIR, "dictionary.db");
const JSONL_GZ = path.join(OUT_DIR, "wiktionary-en.jsonl.gz");

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[dict] ${msg}\n`);
}

// ── Step 1: Download Wiktionary extract ─────────────────────────────

async function downloadWiktionary() {
  if (existsSync(JSONL_GZ)) {
    log(`Wiktionary extract already downloaded: ${JSONL_GZ}`);
    return;
  }
  log(`Downloading Wiktionary extract (~450 MB)...`);
  const resp = await fetch(WIKTIONARY_URL);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const dest = createWriteStream(JSONL_GZ);
  // @ts-ignore — ReadableStream → NodeStream pipeline
  await pipeline(resp.body, dest);
  log(`Download complete.`);
}

// ── Step 2: Create SQLite DB and process ────────────────────────────

function createDb() {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.pragma("cache_size = -256000"); // 256 MB cache during build
  db.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL COLLATE NOCASE,
      pos TEXT,
      pronunciation TEXT
    );
    CREATE TABLE definitions (
      id TEXT PRIMARY KEY,
      word_id TEXT NOT NULL REFERENCES words(id),
      definition TEXT NOT NULL,
      example TEXT
    );
  `);
  return db;
}

function createIndexes(db) {
  log("Creating indexes...");
  db.exec(`
    CREATE INDEX idx_words_word ON words(word COLLATE NOCASE);
    CREATE INDEX idx_definitions_word_id ON definitions(word_id);
  `);
}

async function processWiktionary(db) {
  log("Processing Wiktionary entries...");
  const { createReadStream } = await import("node:fs");
  const stream = createReadStream(JSONL_GZ).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const insertWord = db.prepare(
    "INSERT INTO words (id, word, pos, pronunciation) VALUES (?, ?, ?, ?)",
  );
  const insertDef = db.prepare(
    "INSERT INTO definitions (id, word_id, definition, example) VALUES (?, ?, ?, ?)",
  );

  const batchInsert = db.transaction((entries) => {
    for (const entry of entries) {
      insertWord.run(
        entry.wordId,
        entry.word,
        entry.pos,
        entry.pronunciation,
      );
      for (const def of entry.defs) {
        insertDef.run(def.id, entry.wordId, def.definition, def.example);
      }
    }
  });

  let count = 0;
  let defCount = 0;
  let batch = [];

  for await (const line of rl) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Only English entries
    if (entry.lang && entry.lang !== "English") continue;

    const word = entry.word;
    if (!word) continue;

    const pos = entry.pos || null;

    // Extract IPA pronunciation
    let pronunciation = null;
    if (Array.isArray(entry.sounds)) {
      for (const s of entry.sounds) {
        if (s.ipa) {
          pronunciation = s.ipa;
          break;
        }
      }
    }

    // Extract definitions from senses
    const defs = [];
    if (Array.isArray(entry.senses)) {
      for (const sense of entry.senses) {
        const glosses = sense.glosses || sense.raw_glosses;
        if (!Array.isArray(glosses) || glosses.length === 0) continue;
        // Use the last gloss (most specific) — Wiktionary nests
        // general→specific, and the final entry is the actual definition.
        const definition = glosses[glosses.length - 1];
        if (!definition || definition.length < 2) continue;

        let example = null;
        if (Array.isArray(sense.examples)) {
          for (const ex of sense.examples) {
            if (ex.text && ex.type === "example") {
              example = ex.text;
              break;
            }
          }
        }

        defs.push({
          id: randomUUID(),
          definition,
          example: example || null,
        });
      }
    }

    if (defs.length === 0) continue;

    const wordId = randomUUID();
    batch.push({
      wordId,
      word,
      pos,
      pronunciation,
      defs,
    });
    defCount += defs.length;

    if (batch.length >= 5000) {
      batchInsert(batch);
      count += batch.length;
      batch = [];
      if (count % 50000 === 0) {
        log(`  ${count.toLocaleString()} words, ${defCount.toLocaleString()} definitions...`);
      }
    }
  }

  if (batch.length > 0) {
    batchInsert(batch);
    count += batch.length;
  }

  log(
    `Wiktionary: ${count.toLocaleString()} words, ${defCount.toLocaleString()} definitions`,
  );
  return count;
}

// ── Step 3: Add WordNet entries for words Wiktionary missed ─────────

function processWordNet(db) {
  log("Adding WordNet entries...");

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let wnPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    wnPath = require("wordnet-db").path;
  } catch {
    log("  wordnet-db not installed, skipping WordNet supplement.");
    return;
  }

  const POS_MAP = { noun: "noun", verb: "verb", adj: "adjective", adv: "adverb" };
  const POS_TAG = { noun: "n", verb: "v", adj: "a", adv: "r" };
  const POS_FILES = ["noun", "verb", "adj", "adv"];

  // Parse data files for synset glosses
  const synsets = new Map(); // "offset:tag" → { def, example }
  for (const posFile of POS_FILES) {
    const tag = POS_TAG[posFile];
    const content = readFileSync(path.join(wnPath, `data.${posFile}`), "utf-8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const pipeIdx = line.indexOf("|");
      if (pipeIdx < 0) continue;
      const offset = line.substring(0, 8).trim();
      const gloss = line.substring(pipeIdx + 1).trim();
      const parts = gloss.split(";").map((s) => s.trim());
      const defParts = [];
      let example = null;
      for (const p of parts) {
        if (p.startsWith('"') && p.endsWith('"')) {
          if (!example) example = p.slice(1, -1);
        } else {
          defParts.push(p);
        }
      }
      const def = defParts.join("; ");
      if (def) synsets.set(`${offset}:${tag}`, { def, example });
    }
  }

  // Parse index files and insert words not already in the DB
  const checkWord = db.prepare(
    "SELECT 1 FROM words WHERE word = ? COLLATE NOCASE AND pos = ? LIMIT 1",
  );
  const insertWord = db.prepare(
    "INSERT INTO words (id, word, pos, pronunciation) VALUES (?, ?, ?, ?)",
  );
  const insertDef = db.prepare(
    "INSERT INTO definitions (id, word_id, definition, example) VALUES (?, ?, ?, ?)",
  );

  const batchInsert = db.transaction((entries) => {
    for (const entry of entries) {
      insertWord.run(entry.wordId, entry.word, entry.wordLower, entry.pos, null);
      for (const def of entry.defs) {
        insertDef.run(def.id, entry.wordId, def.definition, def.example);
      }
    }
  });

  let added = 0;
  let batch = [];

  for (const posFile of POS_FILES) {
    const tag = POS_TAG[posFile];
    const posLabel = POS_MAP[posFile];
    const content = readFileSync(path.join(wnPath, `index.${posFile}`), "utf-8");

    for (const line of content.split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const fields = line.split(/\s+/);
      const lemma = fields[0].replace(/_/g, " ");
      const synsetCnt = parseInt(fields[2], 10);
      if (isNaN(synsetCnt) || synsetCnt === 0) continue;

      // Skip if Wiktionary already has this word+pos
      if (checkWord.get(lemma, posLabel)) continue;

      const offsets = fields.slice(-synsetCnt);
      const defs = [];
      for (const offset of offsets) {
        const synset = synsets.get(`${offset}:${tag}`);
        if (synset) {
          defs.push({
            id: randomUUID(),
            definition: synset.def,
            example: synset.example || null,
          });
        }
      }
      if (defs.length === 0) continue;

      batch.push({
        wordId: randomUUID(),
        word: lemma,
        pos: posLabel,
        defs,
      });

      if (batch.length >= 5000) {
        batchInsert(batch);
        added += batch.length;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    batchInsert(batch);
    added += batch.length;
  }

  log(`WordNet supplement: ${added.toLocaleString()} additional words`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const start = Date.now();
  await downloadWiktionary();
  const db = createDb();
  try {
    await processWiktionary(db);
    processWordNet(db);
    createIndexes(db);
    db.pragma("journal_mode = WAL");

    // Stats
    const wordCount = db.prepare("SELECT COUNT(*) as c FROM words").get().c;
    const defCount = db.prepare("SELECT COUNT(*) as c FROM definitions").get().c;
    log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    log(`Total: ${wordCount.toLocaleString()} words, ${defCount.toLocaleString()} definitions`);
    log(`Database: ${DB_PATH}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
