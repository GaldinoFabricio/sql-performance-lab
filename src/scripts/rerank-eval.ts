import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { RERANKER_MODEL } from "../embeddings/model";
import { mean, percentile } from "../evals/metrics";
import { codesIn, knownCodes as loadKnownCodes } from "../search/codes";
import { rerank, RerankDoc } from "../search/rerank";
import { Hit, hybridSearch, vectorSearch } from "../search/search";
import { SEARCH_DEFAULTS } from "../services/search.service";

/**
 * Does a cross-encoder reranker fix what the first-stage search gets wrong?
 *
 * For every query, the first stage runs the way GET /search/logs does by
 * default (no INFO, ef_search 160; hybrid with 40 candidates per list, the
 * error-code list at weight 2) and returns its top N. The reranker
 * (src/search/rerank.ts) reorders those N and keeps 10. Measured per N:
 *
 *   before    precision@10 of the first stage's own top 10
 *   after     precision@10 after reranking its top N
 *   ceiling   min(relevant among the N, 10) / 10: the best any reordering of
 *             those N can do. A reranker can't find a log the first stage
 *             didn't return, so when "after" is far below "ceiling" the
 *             model is the problem; when "ceiling" is low, the first stage is.
 *
 * Query sets: evals/text_queries.json (60 typed queries, by kind) and
 * evals/code_queries.json (114 error-code queries). For code queries the
 * relevance comes from the code itself, so they check that the reranker
 * doesn't undo the code fix, not how good it is.
 *
 * Latency: the reranker only (message fetch + scoring), client-side wall
 * time, median of 3 runs after a warm-up; first-stage time is in eval:search.
 *
 * --doc picks what the reranker reads (rerankText): "code" (default) puts
 * the error code in front of the message, "message" is the message alone.
 *
 * Usage: pnpm eval:rerank [--n=20,50] [--doc=code|message] [--stages=hybrid,vector] [--codes=false] [--out=...]
 */

type Stage = "hybrid" | "vector";
interface Query { text: string; expected: string[]; set: "text" | "codes"; kind: string }

const ROOT = path.resolve(__dirname, "../..");
const K = 10;
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const NS = (flag("n") ?? "20,50").split(",").map(Number).sort((a, b) => a - b);
const WITH_CODES = flag("codes") !== "false";
const STAGES = (flag("stages") ?? "hybrid,vector").split(",") as Stage[];
const DOC = (flag("doc") ?? "code") as RerankDoc;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function loadQueries(): Query[] {
   const text: { text: string; expected: string; kind: string }[] =
      JSON.parse(readFileSync(path.join(ROOT, "evals/text_queries.json"), "utf8")).queries;
   const queries: Query[] = text.map((q) => ({ text: q.text, expected: [q.expected], set: "text", kind: q.kind }));
   if (WITH_CODES) {
      const codes: { text: string; expected: string[]; form: string }[] =
         JSON.parse(readFileSync(path.join(ROOT, "evals/code_queries.json"), "utf8")).queries;
      queries.push(...codes.map((q) => ({ text: q.text, expected: q.expected, set: "codes" as const, kind: q.form })));
   }
   return queries;
}

interface Row {
   before: number;
   after: Record<number, number>;
   ceiling: Record<number, number>;
   ms: Record<number, number>;
   top3: { before: string[]; after: Record<number, string[]> };
}

async function run() {
   const queries = loadQueries();
   const { rows: [info] } = await db.raw("SELECT count(*)::int AS rows, count(embedding)::int AS embedded FROM logs");
   if (info.rows === 0 || info.embedded !== info.rows) throw new Error("run pnpm seed:logs and pnpm embed:logs first");
   const size = info.rows >= 1_000_000 ? `${info.rows / 1_000_000}m` : `${info.rows / 1000}k`;
   const known = await loadKnownCodes(db);
   const maxN = NS[NS.length - 1];

   const firstStage = (q: Query, vec: string, stage: Stage): Promise<Hit[]> =>
      db.transaction(async (trx) => {
         await trx.raw(`SET LOCAL hnsw.ef_search = ${Math.max(SEARCH_DEFAULTS.efSearch, maxN)}`);
         if (stage === "vector") return vectorSearch(trx, vec, maxN, null, true);
         return hybridSearch(trx, q.text, vec, maxN, null, {
            candidates: SEARCH_DEFAULTS.hybridCandidates,
            rrfK: SEARCH_DEFAULTS.rrfK,
            vectorWeight: SEARCH_DEFAULTS.vectorWeight,
            keywordWeight: SEARCH_DEFAULTS.keywordWeight,
            notInfo: true,
            codes: codesIn(q.text, known),
            codeWeight: SEARCH_DEFAULTS.codeWeight,
         });
      });

   const relevant = (q: Query, hits: { root_cause: string | null }[]) =>
      hits.filter((h) => h.root_cause !== null && q.expected.includes(h.root_cause)).length;
   const causes = (hits: { root_cause: string | null }[]) => hits.slice(0, 3).map((h) => h.root_cause ?? "null");

   const per = Object.fromEntries(STAGES.map((s) => [s, [] as Row[]])) as Record<Stage, Row[]>;
   for (const [n, q] of queries.entries()) {
      if (n % 20 === 0) process.stdout.write(`\r${n}/${queries.length} queries`);
      const vec = toPgVector((await embed([q.text]))[0]);
      for (const stage of STAGES) {
         const hits = await firstStage(q, vec, stage);
         const row: Row = { before: relevant(q, hits.slice(0, K)) / K, after: {}, ceiling: {}, ms: {}, top3: { before: causes(hits), after: {} } };
         for (const N of NS) {
            const candidates = hits.slice(0, N);
            await rerank(db, q.text, candidates, K, DOC); // warm-up
            const times: number[] = [];
            let out: Awaited<ReturnType<typeof rerank<Hit>>> = [];
            for (let r = 0; r < 3; r++) {
               const t = performance.now();
               out = await rerank(db, q.text, candidates, K, DOC);
               times.push(performance.now() - t);
            }
            row.after[N] = relevant(q, out) / K;
            row.ceiling[N] = Math.min(relevant(q, candidates), K) / K;
            row.ms[N] = percentile(times, 50);
            row.top3.after[N] = causes(out);
         }
         per[stage].push(row);
      }
   }
   process.stdout.write("\r");

   // ---- report ----
   const groups = [
      { name: "text: all", idx: queries.flatMap((q, i) => (q.set === "text" ? [i] : [])) },
      ...["keyword", "mixed", "paraphrase"].map((k) => ({ name: `text: ${k}`, idx: queries.flatMap((q, i) => (q.set === "text" && q.kind === k ? [i] : [])) })),
      ...(WITH_CODES ? [{ name: "codes: all", idx: queries.flatMap((q, i) => (q.set === "codes" ? [i] : [])) }] : []),
   ];
   const summarize = (stage: Stage, idx: number[]) => {
      const xs = idx.map((i) => per[stage][i]);
      return {
         queries: idx.length,
         before: mean(xs.map((x) => x.before)),
         zero_before: xs.filter((x) => x.before === 0).length,
         by_n: Object.fromEntries(
            NS.map((N) => [N, {
               after: mean(xs.map((x) => x.after[N])),
               ceiling: mean(xs.map((x) => x.ceiling[N])),
               zero_after: xs.filter((x) => x.after[N] === 0).length,
               better: xs.filter((x) => x.after[N] > x.before).length,
               worse: xs.filter((x) => x.after[N] < x.before).length,
               p50_ms: percentile(xs.map((x) => x.ms[N]), 50),
               p95_ms: percentile(xs.map((x) => x.ms[N]), 95),
            }]),
         ),
      };
   };
   const summary = Object.fromEntries(STAGES.map((s) => [s, Object.fromEntries(groups.map((g) => [g.name, summarize(s, g.idx)]))]));

   console.log(`logs: ${info.rows.toLocaleString()} rows; reranker ${RERANKER_MODEL.id} reading ${DOC}; first stage like GET /search/logs (no INFO, ef_search ${SEARCH_DEFAULTS.efSearch}, cw ${SEARCH_DEFAULTS.codeWeight})`);
   for (const stage of STAGES) {
      console.log(`\n${stage}: precision@10 (queries with 0 relevant)`);
      console.log(`${"".padEnd(18)}${"before".padEnd(14)}${NS.map((N) => `top ${N}: after / ceiling`.padEnd(32)).join("")}`);
      for (const g of groups) {
         const s = summary[stage][g.name];
         console.log(
            g.name.padEnd(18) + `${pct(s.before)} (${s.zero_before})`.padEnd(14) +
               NS.map((N) => `${pct(s.by_n[N].after)} (${s.by_n[N].zero_after}) / ${pct(s.by_n[N].ceiling)}  +${s.by_n[N].better} -${s.by_n[N].worse}`.padEnd(32)).join(""),
         );
      }
      console.log(`rerank latency, all queries: ${NS.map((N) => { const s = summarize(stage, queries.map((_, i) => i)).by_n[N]; return `top ${N} p50 ${s.p50_ms.toFixed(0)} ms / p95 ${s.p95_ms.toFixed(0)} ms`; }).join(", ")}`);
   }

   console.log(`\ntyped queries whose precision changed (hybrid, top ${NS[0]}), top-3 root causes before -> after:`);
   for (const [i, q] of queries.entries()) {
      const r = per.hybrid[i];
      if (!r || q.set !== "text" || r.after[NS[0]] === r.before) continue;
      console.log(`  ${q.text.slice(0, 44).padEnd(46)}${pct(r.before).padStart(6)} -> ${pct(r.after[NS[0]]).padEnd(7)} [${r.top3.before.join(", ")}] -> [${r.top3.after[NS[0]].join(", ")}]`);
   }

   const out = flag("out") ? path.resolve(ROOT, flag("out")!) : path.join(ROOT, `evals/results/rerank-${size}${DOC === "code" ? "" : `-${DOC}`}.json`);
   mkdirSync(path.dirname(out), { recursive: true });
   writeFileSync(
      out,
      JSON.stringify(
         {
            created_at: new Date().toISOString(),
            rows: info.rows,
            k: K,
            reranker: { model: RERANKER_MODEL.id, revision: RERANKER_MODEL.revision, dtype: "fp32", doc: DOC },
            settings: { not_info: true, ef_search: SEARCH_DEFAULTS.efSearch, hybrid_candidates: SEARCH_DEFAULTS.hybridCandidates, rrf_k: SEARCH_DEFAULTS.rrfK, code_weight: SEARCH_DEFAULTS.codeWeight, n: NS },
            latency_note: "reranker only (message fetch + scoring), client-side wall time, median of 3 runs per query after a warm-up run",
            summary,
            per_query: queries.map((q, i) => ({
               text: q.text, set: q.set, kind: q.kind, expected: q.expected,
               ...Object.fromEntries(STAGES.map((s) => [s, per[s][i]])),
            })),
         },
         null,
         2,
      ) + "\n",
   );
   console.log(`\nwrote ${path.relative(ROOT, out)}`);
}

run()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
