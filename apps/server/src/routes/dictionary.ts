import { Hono } from "hono";
import { lookup, isAvailable } from "../services/dictionary.js";

const dictionaryRouter = new Hono();

/**
 * GET /dictionary/:word
 *
 * Public endpoint — no auth required. Returns definitions, POS, pronunciation,
 * and examples for the given word. Uses case-insensitive exact match, then
 * inflection stemming, then fuzzy Levenshtein as fallback.
 */
dictionaryRouter.get("/dictionary/:word", (c) => {
  if (!isAvailable()) {
    return c.json(
      { error: "Dictionary not configured on this server" },
      503,
    );
  }

  const word = decodeURIComponent(c.req.param("word"));
  const result = lookup(word);

  if (!result) {
    return c.json({ error: "Word not found", query: word }, 404);
  }

  return c.json(result);
});

export default dictionaryRouter;
