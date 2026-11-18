import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { likePattern } from "../evals/metrics";
import { routeWeights } from "../search/routing";
import { fullTextSearch, Hit, hybridSearch, likeSearch, vectorSearch } from "../search/search";
import { templateSearch, templatesReady, TemplateHit } from "../search/templates";

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
 *    on typed queries had not flattened at 1M, so callers may go up to 1000;
 *  - INFO logs are left out unless include_info=true: the HNSW index is
 *    partial, WHERE level <> 'INFO' (migration 20261118120000), because
 *    incident searches got more precise and INFO inserts cheaper without
 *    them. With include_info=true no index covers the rows, so vector and
 *    hybrid scan every row exactly: fine at 10k, ~220 ms at 1M rows.
 *  - template: exact search over one embedding per log template
 *    (pnpm templates:build), then the newest logs of the nearest templates.
 */
export const SEARCH_MODES = ["hybrid", "vector", "fulltext", "like", "template"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const SEARCH_DEFAULTS = {
   mode: "hybrid" as SearchMode,
   k: 10,
   maxK: 50,
   efSearch: 160,
   efSearchRange: [10, 1000] as const,
   hybridCandidates: 40,
   vectorWeight: 1.0,
   keywordWeight: 1.0,
   weightRange: [0, 5] as const,
   rrfK: 60,
   rrfKRange: [1, 1000] as const,
   maxQueryLength: 500,
};

export interface SearchParams {
   q: string;
   mode: SearchMode;
   k: number;
   efSearch: number;
   /** RRF weights for the hybrid mode. Undefined = not set by the caller. */
   vectorWeight?: number;
   keywordWeight?: number;
   /** RRF constant for the hybrid mode: score = weight / (rrfK + rank). */
   rrfK: number;
   /** Hybrid only: pick the weights from the query (routing.ts) when none are given. Off by default. */
   route: boolean;
   /** Search INFO logs too. Off by default: the HNSW index leaves them out. */
   includeInfo: boolean;
}

/** Where the hybrid weights came from: the caller, the router, or the fixed default. */
export type WeightsFrom = "explicit" | "routed" | "fixed";

export interface HybridWeights {
   vectorWeight: number;
   keywordWeight: number;
   from: WeightsFrom;
}

/**
 * Explicit vw/fw always win (manual tests). If only one is given, the other
 * takes the fixed default, so a half-explicit request never mixes in routing.
 * Otherwise route the query when route=true, or use the fixed 1/1 (the default).
 */
export function hybridWeights(p: Pick<SearchParams, "q" | "vectorWeight" | "keywordWeight" | "route">): HybridWeights {
   if (p.vectorWeight !== undefined || p.keywordWeight !== undefined) {
      return {
         vectorWeight: p.vectorWeight ?? SEARCH_DEFAULTS.vectorWeight,
         keywordWeight: p.keywordWeight ?? SEARCH_DEFAULTS.keywordWeight,
         from: "explicit",
      };
   }
   if (p.route) return { ...routeWeights(p.q), from: "routed" };
   return { vectorWeight: SEARCH_DEFAULTS.vectorWeight, keywordWeight: SEARCH_DEFAULTS.keywordWeight, from: "fixed" };
}

export interface LogResult {
   id: number;
   created_at: string;
   service: string;
   level: string;
   error_code: string | null;
   message: string;
   /** Template mode only: the template this log matched through. */
   template?: { id: number; text: string; log_count: number; distance: number };
}

/** The search can't run yet (e.g. templates not built); maps to HTTP 503. */
export class SearchUnavailableError extends Error {}

export interface SearchResponse {
   query: string;
   mode: SearchMode;
   k: number;
   ef_search: number | null;
   include_info: boolean;
   /** Hybrid only (null for the other modes): the RRF settings actually used. */
   hybrid: { vector_weight: number; keyword_weight: number; weights_from: WeightsFrom; rrf_k: number } | null;
   ms: { embed: number; search: number; total: number };
   results: LogResult[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function searchLogs(p: SearchParams): Promise<SearchResponse> {
   const start = performance.now();
   const needsVector = p.mode === "vector" || p.mode === "hybrid" || p.mode === "template";
   // template search is exact over a few dozen rows: no HNSW, no ef_search.
   // With INFO included no index covers the rows: an exact scan, no ef_search either.
   const usesHnsw = (p.mode === "vector" || p.mode === "hybrid") && !p.includeInfo;
   const notInfo = !p.includeInfo;
   if (p.mode === "template" && !(await templatesReady(db))) {
      throw new SearchUnavailableError("templates are not built: run pnpm templates:build");
   }

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
   const weights = p.mode === "hybrid" ? hybridWeights(p) : null;
   const t = performance.now();
   const hits: (Hit | TemplateHit)[] = await db.transaction(async (trx) => {
      if (usesHnsw) {
         await trx.raw(`SET LOCAL hnsw.ef_search = ${Number(efSearch)}`);
      }
      switch (p.mode) {
         case "vector":
            return vectorSearch(trx, vec, p.k, null, notInfo);
         case "hybrid":
            return hybridSearch(trx, p.q, vec, p.k, null, {
               candidates: SEARCH_DEFAULTS.hybridCandidates,
               vectorWeight: weights!.vectorWeight,
               keywordWeight: weights!.keywordWeight,
               rrfK: p.rrfK,
               notInfo,
            });
         case "fulltext":
            return fullTextSearch(trx, p.q, p.k, null, notInfo);
         case "like":
            return likeSearch(trx, likePattern(p.q, Number.MAX_SAFE_INTEGER), p.k, null, notInfo);
         case "template":
            return templateSearch(trx, vec, p.k, null, notInfo);
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
   for (const h of hits) if ("template" in h && byId.has(h.id)) byId.get(h.id)!.template = h.template;
   const searchMs = performance.now() - t;

   return {
      query: p.q,
      mode: p.mode,
      k: p.k,
      ef_search: usesHnsw ? efSearch : null,
      include_info: p.includeInfo,
      hybrid: weights && {
         vector_weight: weights.vectorWeight,
         keyword_weight: weights.keywordWeight,
         weights_from: weights.from,
         rrf_k: p.rrfK,
      },
      ms: { embed: round(embedMs), search: round(searchMs), total: round(performance.now() - start) },
      results: ids.map((id) => byId.get(id)!).filter(Boolean),
   };
}
