import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { likePattern } from "../evals/metrics";
import { fullTextSearch, Hit, hybridSearch, likeSearch, vectorSearch } from "../search/search";

/**
 * Log search behind GET /search/logs.
 *
 * Defaults come from the experiments in SEMANTIC_SEARCH.md:
 *  - hybrid is the default mode: vectors alone return 0 of 10 relevant logs
 *    for some exact error codes (x509, ECONNRESET), keywords alone miss
 *    paraphrases; RRF keeps most of both;
 *  - ef_search 160 on the m=32, ef_construction=200 index (migration
 *    20261115130000): the largest value measured at every table size, and
 *    still under 2 ms p50 at 1M rows, less than embedding the query. Recall
 *    on typed queries had not flattened at 1M, so callers may go up to 1000.
 */
export const SEARCH_MODES = ["hybrid", "vector", "fulltext", "like"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const SEARCH_DEFAULTS = {
   mode: "hybrid" as SearchMode,
   k: 10,
   maxK: 50,
   efSearch: 160,
   efSearchRange: [10, 1000] as const,
   hybridCandidates: 40,
   maxQueryLength: 500,
};

export interface SearchParams {
   q: string;
   mode: SearchMode;
   k: number;
   efSearch: number;
}

export interface LogResult {
   id: number;
   created_at: string;
   service: string;
   level: string;
   error_code: string | null;
   message: string;
}

export interface SearchResponse {
   query: string;
   mode: SearchMode;
   k: number;
   ef_search: number | null;
   ms: { embed: number; search: number; total: number };
   results: LogResult[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function searchLogs(p: SearchParams): Promise<SearchResponse> {
   const start = performance.now();
   const needsVector = p.mode === "vector" || p.mode === "hybrid";

   let embedMs = 0;
   let vec = "";
   if (needsVector) {
      const t = performance.now();
      vec = toPgVector((await embed([p.q]))[0]);
      embedMs = performance.now() - t;
   }

   // ef_search is per transaction (SET LOCAL), so it never leaks into other
   // requests sharing the pooled connection. Hybrid asks the vector side for
   // `hybridCandidates` rows, so ef_search must be at least that.
   const efSearch = p.mode === "hybrid" ? Math.max(p.efSearch, SEARCH_DEFAULTS.hybridCandidates) : p.efSearch;
   const t = performance.now();
   const hits: Hit[] = await db.transaction(async (trx) => {
      if (needsVector) {
         await trx.raw(`SET LOCAL hnsw.ef_search = ${Number(efSearch)}`);
      }
      switch (p.mode) {
         case "vector":
            return vectorSearch(trx, vec, p.k);
         case "hybrid":
            return hybridSearch(trx, p.q, vec, p.k, null, { candidates: SEARCH_DEFAULTS.hybridCandidates });
         case "fulltext":
            return fullTextSearch(trx, p.q, p.k);
         case "like":
            return likeSearch(trx, likePattern(p.q, Number.MAX_SAFE_INTEGER), p.k);
      }
   });

   // Search returns ranked ids; the rows are fetched once, by primary key,
   // and put back in rank order. root_cause is a seed-only eval label and is
   // never exposed.
   const ids = hits.map((h) => h.id);
   const { rows } = await db.raw(
      `SELECT id, created_at, service, level, error_code, message FROM logs WHERE id = ANY(?::bigint[])`,
      [ids],
   );
   const byId = new Map<number, LogResult>(rows.map((r: any) => [Number(r.id), { ...r, id: Number(r.id) }]));
   const searchMs = performance.now() - t;

   return {
      query: p.q,
      mode: p.mode,
      k: p.k,
      ef_search: needsVector ? efSearch : null,
      ms: { embed: round(embedMs), search: round(searchMs), total: round(performance.now() - start) },
      results: ids.map((id) => byId.get(id)!).filter(Boolean),
   };
}
