import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { likePattern } from "../evals/metrics";
import { codesIn, KnownCodes, knownCodes } from "../search/codes";
import { routeWeights } from "../search/routing";
import { fullTextSearch, Hit, hybridSearch, likeSearch, vectorSearch } from "../search/search";
import { templateSearch, templatesReady, TemplateHit } from "../search/templates";
import { RERANKER_MODEL } from "../embeddings/model";
import { rerank as rerankHits, RerankDoc } from "../search/rerank";

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
 *  - rerank=N (off by default): the first stage returns N candidates and a
 *    cross-encoder (src/search/rerank.ts) reorders them, reading each log's
 *    template + its LLM-written description. pnpm eval:rerank, hybrid, top 50:
 *    88.8–91.3% -> 96.5–98.2% at 100k rows, +14–21 ms p50. Off by default
 *    because it loads a second model (~91 MB, ~0.4 s on the first request).
 *  - tw (off by default): hybrid's 4th RRF list, logs of the nearest
 *    templates. It raises the candidates' ceiling, but with the reranker on
 *    it measured lower (97.5% vs 98.2% at 100k), and alone it was within noise.
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
   // Weight of the error-code list (pnpm eval:codes, evals/results/codes-10k.json).
   // At 1 a code-only log ties with the top of a single other list, and 2 of 114
   // code queries in a sentence still found nothing relevant; at 2 none did.
   // Above 2 the code list simply wins, which that eval can't judge (its
   // relevance is defined by the code), so the default stays at 2.
   codeWeight: 2.0,
   knownCodesTtlMs: 60_000,
   weightRange: [0, 5] as const,
   rrfK: 60,
   rrfKRange: [1, 1000] as const,
   rerank: 0,
   maxRerank: 100,
   rerankDoc: "template" as RerankDoc,
   templateWeight: 0,
   templateLists: 3,
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
   /** Hybrid only: RRF weight of the error-code list (0 turns it off). */
   codeWeight: number;
   /** RRF constant for the hybrid mode: score = weight / (rrfK + rank). */
   rrfK: number;
   /** Hybrid only: pick the weights from the query (routing.ts) when none are given. Off by default. */
   route: boolean;
   /** Search INFO logs too. Off by default: the HNSW index leaves them out. */
   includeInfo: boolean;
   /** Rerank the first stage's top N with the cross-encoder; 0 = off. N >= k. */
   rerank: number;
   /** Hybrid only: RRF weight of the nearest templates' logs (0 turns it off). */
   templateWeight: number;
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
   /** With rerank: the cross-encoder's logit (higher = more relevant; only the order means something). */
   rerank_score?: number;
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
   hybrid: {
      vector_weight: number;
      keyword_weight: number;
      weights_from: WeightsFrom;
      rrf_k: number;
      /** Error codes found in the query (src/search/codes.ts) and the weight of their list. */
      codes: string[];
      code_weight: number;
      /** Weight of the nearest-templates list (0 = off). */
      template_weight: number;
   } | null;
   /** null when rerank=0. */
   rerank: { candidates: number; model: string; doc: RerankDoc } | null;
   ms: { embed: number; search: number; rerank: number; total: number };
   results: LogResult[];
}

const round = (n: number) => Math.round(n * 100) / 100;

// The distinct error codes change only when new codes are logged: read them
// at most once a minute (a skip scan, ~1 ms) instead of on every search.
let codeCache: { at: number; codes: KnownCodes } | null = null;
async function cachedKnownCodes(): Promise<KnownCodes> {
   if (!codeCache || performance.now() - codeCache.at > SEARCH_DEFAULTS.knownCodesTtlMs) {
      codeCache = { at: performance.now(), codes: await knownCodes(db) };
   }
   return codeCache.codes;
}

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

   // With rerank the first stage returns N candidates instead of k.
   const firstK = p.rerank > 0 ? Math.max(p.rerank, p.k) : p.k;

   // ef_search is per transaction (SET LOCAL), so it never leaks into other
   // requests sharing the pooled connection. Hybrid asks the vector side for
   // `hybridCandidates` rows, and vector for firstK, so ef_search must be at
   // least that or HNSW returns fewer rows.
   const efSearch = Math.max(p.efSearch, p.mode === "hybrid" ? SEARCH_DEFAULTS.hybridCandidates : firstK);
   const weights = p.mode === "hybrid" ? hybridWeights(p) : null;
   const codes = p.mode === "hybrid" ? codesIn(p.q, await cachedKnownCodes()) : [];
   const t = performance.now();
   const firstHits: (Hit | TemplateHit)[] = await db.transaction(async (trx) => {
      if (usesHnsw) {
         await trx.raw(`SET LOCAL hnsw.ef_search = ${Number(efSearch)}`);
      }
      switch (p.mode) {
         case "vector":
            return vectorSearch(trx, vec, firstK, null, notInfo);
         case "hybrid":
            return hybridSearch(trx, p.q, vec, firstK, null, {
               candidates: SEARCH_DEFAULTS.hybridCandidates,
               vectorWeight: weights!.vectorWeight,
               keywordWeight: weights!.keywordWeight,
               rrfK: p.rrfK,
               notInfo,
               codes,
               codeWeight: p.codeWeight,
               templateWeight: p.templateWeight,
               templates: SEARCH_DEFAULTS.templateLists,
            });
         case "fulltext":
            return fullTextSearch(trx, p.q, firstK, null, notInfo);
         case "like":
            return likeSearch(trx, likePattern(p.q, Number.MAX_SAFE_INTEGER), firstK, null, notInfo);
         case "template":
            return templateSearch(trx, vec, firstK, null, notInfo);
      }
   });
   const searchDone = performance.now();

   // Second stage: the cross-encoder reorders the N candidates and keeps k.
   let ranked: ((Hit | TemplateHit) & { rerank_score?: number })[] = firstHits;
   let rerankMs = 0;
   if (p.rerank > 0) {
      ranked = await rerankHits(db, p.q, firstHits, p.k, SEARCH_DEFAULTS.rerankDoc);
      rerankMs = performance.now() - searchDone;
   }

   // Search returns ranked ids; the rows are fetched once, by primary key,
   // and put back in rank order. root_cause is a seed-only eval label and is
   // never exposed.
   const ids = ranked.map((h) => h.id);
   const { rows } = await db.raw(
      `SELECT id, created_at, service, level, error_code, message FROM logs WHERE id = ANY(?::bigint[])`,
      [ids],
   );
   const byId = new Map<number, LogResult>(rows.map((r: any) => [Number(r.id), { ...r, id: Number(r.id) }]));
   for (const h of ranked) {
      const log = byId.get(h.id);
      if (!log) continue;
      if ("template" in h) log.template = h.template;
      if (h.rerank_score !== undefined) log.rerank_score = round(h.rerank_score);
   }
   const searchMs = performance.now() - t - rerankMs;

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
         codes,
         code_weight: p.codeWeight,
         template_weight: p.templateWeight,
      },
      rerank: p.rerank > 0 ? { candidates: firstK, model: RERANKER_MODEL.id, doc: SEARCH_DEFAULTS.rerankDoc } : null,
      ms: { embed: round(embedMs), search: round(searchMs), rerank: round(rerankMs), total: round(performance.now() - start) },
      results: ids.map((id) => byId.get(id)!).filter(Boolean),
   };
}
