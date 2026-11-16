import { Request, Response } from "express";
import { searchLogs } from "../services/search.service";
import type { LogSearchQuery } from "../validators/search.validator";

// Params already validated and converted by validateLogSearch (src/validators/search.validator.ts).
export async function getLogSearch(req: Request, res: Response) {
   const { q, mode, k, ef_search: efSearch } = req.query as unknown as LogSearchQuery;
   try {
      res.json(await searchLogs({ q, mode, k, efSearch }));
   } catch (err) {
      res.status(500).json({ error: "Search failed", detail: String(err) });
   }
}
