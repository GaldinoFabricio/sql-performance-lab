import { existsSync } from "fs";
import { cpus } from "os";
import path from "path";
import {
   AutoModelForSequenceClassification,
   AutoTokenizer,
   env,
   type PreTrainedModel,
   type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { modelDir, MODELS_ROOT, RERANKER_MODEL } from "../embeddings/model";
import { describe } from "../logs/descriptions";
import type { Conn } from "./search";

/**
 * Second-stage reranking with a cross-encoder (ms-marco-MiniLM-L-6-v2).
 *
 * The searches in search.ts compare two vectors made separately (bi-encoder)
 * or count shared words. A cross-encoder reads the query and one log
 * together, so every word of one can attend to every word of the other, and
 * outputs one relevance logit per pair. It's usually more precise, but it
 * costs one model run per (query, log) pair, so it only reorders the few
 * candidates a first-stage search returns, never the whole table.
 *
 * Scores are raw logits: higher = more relevant. Only their order matters
 * (no calibration between queries).
 */

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODELS_ROOT;

/**
 * Pairs are scored in batches of this size, sorted by token length.
 * A batch is padded to its longest pair, and logs range from ~20 tokens to
 * ~190 (stack traces). Measured with 40 candidates on 4 cores: one batch of
 * 40 = 683 ms, length-sorted batches of 4 = 173 ms, batches of 1 = 197 ms.
 * fp32 has no dynamic quantization, so a pair's score is bit-identical
 * alone or in any batch (checked in rerank.test.ts).
 */
export const RERANK_BATCH = positiveIntOr(process.env.RERANK_BATCH, 4);

/** A positive integer, or `fallback` for anything else (0 would never advance the batch loop, NaN gives NaN scores). */
function positiveIntOr(raw: string | undefined, fallback: number): number {
   const n = Number(raw);
   return raw?.trim() && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** BERT's limit. Logs measured stay under ~200 tokens, so nothing is cut today. */
const MAX_TOKENS = 512;

let loaded: Promise<{ tok: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;

function load() {
   loaded ??= (async () => ({
      tok: await AutoTokenizer.from_pretrained(RERANKER_MODEL.id),
      model: await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL.id, {
         dtype: "fp32",
         session_options: {
            intraOpNumThreads: Number(process.env.EMBEDDING_THREADS ?? cpus().length),
            interOpNumThreads: 1,
         },
      }),
   }))();
   return loaded;
}

/** Whether the reranker model is on disk (`pnpm model:fetch`). */
export function rerankerReady(): boolean {
   return existsSync(path.join(modelDir(RERANKER_MODEL), "onnx/model.onnx"));
}

/** Loads the model and scores one pair, so the first search doesn't pay for it (~0.4 s). */
export async function warmUpReranker(): Promise<void> {
   await scorePairs("warm up", ["warm up"]);
}

/**
 * One relevance logit per text, in the same order as `texts`. Identical
 * texts are scored once (the score is deterministic per pair).
 */
export async function scorePairs(query: string, texts: string[]): Promise<number[]> {
   if (texts.length === 0) return [];
   const distinct = [...new Set(texts)];
   if (distinct.length < texts.length) {
      const scores = await scoreDistinct(query, distinct);
      const byText = new Map(distinct.map((t, i) => [t, scores[i]]));
      return texts.map((t) => byText.get(t)!);
   }
   return scoreDistinct(query, texts);
}

async function scoreDistinct(query: string, texts: string[]): Promise<number[]> {
   const { tok, model } = await load();
   const lengths = texts.map((t) => tok(query, { text_pair: t }).input_ids.dims[1]);
   const order = texts.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b] || a - b);
   const scores = new Array<number>(texts.length);
   for (let i = 0; i < order.length; i += RERANK_BATCH) {
      const idx = order.slice(i, i + RERANK_BATCH);
      const batch = idx.map((j) => texts[j]);
      const inputs = tok(batch.map(() => query), {
         text_pair: batch,
         padding: true,
         truncation: true,
         max_length: MAX_TOKENS,
      });
      const { logits } = await model(inputs);
      const data = logits.data as Float32Array;
      idx.forEach((j, n) => (scores[j] = data[n]));
   }
   return scores;
}

/**
 * Sorts by score, highest first. Equal scores keep the first stage's order,
 * so identical log lines (common: one template, many copies) stay in the
 * order the search returned them.
 */
export function orderByScore<T>(items: T[], scores: number[], k: number): (T & { rerank_score: number })[] {
   return items
      .map((item, i) => ({ item, i, score: scores[i] }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, k)
      .map(({ item, score }) => ({ ...item, rerank_score: score }));
}

/**
 * What the cross-encoder reads for a log.
 *  - "message": the message only.
 *  - "code": the error code in front ("EDQUOT: <message>") when the message
 *    doesn't already contain it. Some codes live only in the error_code
 *    column (SQLSTATE 53100, EDQUOT, NPE), and the first stage finds them
 *    there (src/search/codes.ts); reading the message alone, the reranker
 *    can't see them and pushes those logs down.
 *  - "described": "code", then the description of the log's template
 *    (data/template-descriptions.json) on the next line. The model only knows
 *    words; the description adds the ones the log doesn't contain ("HTTPS"
 *    for an x509 error, "DNS" for ENOTFOUND).
 *  - "template": like "described", but the template text instead of the
 *    message. Copies of one template then read the same text, which is
 *    scored once: fewer and shorter pairs. Logs of the same template tie
 *    and keep the first stage's order.
 */
export type RerankDoc = "message" | "code" | "described" | "template";

export interface RerankLog {
   message: string;
   error_code: string | null;
   /** The log's template (log_template_map), when templates are built. */
   partition?: string | null;
   template?: string | null;
}

export function rerankText(log: RerankLog, doc: RerankDoc): string {
   if (doc === "message") return log.message;
   const body = doc === "template" && log.template ? log.template : log.message;
   const code = log.error_code && !body.toLowerCase().includes(log.error_code.toLowerCase())
      ? `${log.error_code}: ${body}`
      : body;
   if (doc === "code" || !log.partition || !log.template) return code;
   const description = describe(log.partition, log.template);
   return description ? `${code}\n${description}` : code;
}

/**
 * Reorders first-stage `hits` by the cross-encoder and keeps the top `k`.
 * Reads each candidate's text (and template, for "described") once by
 * primary key.
 */
export async function rerank<T extends { id: number }>(
   db: Conn,
   query: string,
   hits: T[],
   k: number,
   doc: RerankDoc = "code",
): Promise<(T & { rerank_score: number })[]> {
   if (hits.length === 0) return [];
   const { rows } = await db.raw(
      doc === "described" || doc === "template"
         ? `SELECT l.id, l.message, l.error_code, t.partition, t.template
            FROM logs l
            LEFT JOIN log_template_map m ON m.log_id = l.id
            LEFT JOIN log_templates t ON t.id = m.template_id
            WHERE l.id = ANY(?::bigint[])`
         : "SELECT id, message, error_code FROM logs WHERE id = ANY(?::bigint[])",
      [hits.map((h) => h.id)],
   );
   const text = new Map<number, string>(rows.map((r: any) => [Number(r.id), rerankText(r, doc)]));
   const scores = await scorePairs(query, hits.map((h) => text.get(h.id) ?? ""));
   return orderByScore(hits, scores, k);
}
