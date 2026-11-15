import { Request, Response } from "express";
import { SEARCH_DEFAULTS, SEARCH_MODES, SearchMode, searchLogs } from "../services/search.service";

function intParam(raw: unknown, fallback: number, min: number, max: number, name: string): number {
   if (raw === undefined || raw === "") return fallback;
   const n = Number(raw);
   if (!Number.isInteger(n) || n < min || n > max) {
      throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
   }
   return n;
}

export async function getLogSearch(req: Request, res: Response) {
   const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
   const mode = (req.query.mode ?? SEARCH_DEFAULTS.mode) as SearchMode;

   let k: number;
   let efSearch: number;
   try {
      if (!q) throw new RangeError("q is required");
      if (q.length > SEARCH_DEFAULTS.maxQueryLength) {
         throw new RangeError(`q must be at most ${SEARCH_DEFAULTS.maxQueryLength} characters`);
      }
      if (!SEARCH_MODES.includes(mode)) throw new RangeError(`mode must be one of ${SEARCH_MODES.join(", ")}`);
      k = intParam(req.query.k, SEARCH_DEFAULTS.k, 1, SEARCH_DEFAULTS.maxK, "k");
      const [lo, hi] = SEARCH_DEFAULTS.efSearchRange;
      efSearch = intParam(req.query.ef_search, SEARCH_DEFAULTS.efSearch, lo, hi, "ef_search");
   } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
   }

   try {
      res.json(await searchLogs({ q, mode, k, efSearch }));
   } catch (err) {
      res.status(500).json({ error: "Search failed", detail: String(err) });
   }
}
