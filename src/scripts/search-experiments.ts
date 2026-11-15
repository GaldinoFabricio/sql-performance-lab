import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { MODEL_ID } from "../embeddings/model";
import { GroundTruth } from "../evals/ground-truth";
import {
   likePattern,
   mean,
   percentile,
   precisionAtK,
   recallAtK,
} from "../evals/metrics";
import {
   Conn,
   fullTextSearch,
   Hit,
   hybridSearch,
   likeSearch,
   vectorSearch,
} from "../search/search";

/**
 * Phase 3 of the semantic search chapter: LIKE, full-text (GIN), exact
 * vector, HNSW (ef_search sweep) and hybrid (RRF) on the same queries.
 *
 * Two query sets:
 *  - the ground truth's logs (log-as-query): recall@k vs exact search, and
 *    precision@k by root_cause;
 *  - evals/text_queries.json (free text, typed by a human): precision only,
 *    since there is no exact answer for "redis is down".
 *
 * Both sets get tie-aware recall@k: for free text the exact top-k is
 * computed here with a sequential scan (exact search is the truth for any
 * query vector, not only for logs already in the table).
 *
 * The HNSW index is built here, once per (m, ef_construction), to time it,
 * and dropped at the end unless --keep-index (which keeps the last one).
 * Results go to evals/results/search-<rows>.json.
 *
 * Usage: pnpm eval:search [--truth=evals/ground_truth.json] [--rounds=3]
 *        [--hnsw=16:64,16:200,32:200] [--repeats=N] [--keep-index]
 *
 * pgvector assigns HNSW levels at random, so two builds of the same config
 * are different graphs with different recall. Each config is built
 * --repeats times (default 3 up to 100k rows, 1 above) and recall is
 * reported as mean [min-max] across builds.
 */

const flag = (name: string) =>
   process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ROOT = path.resolve(__dirname, "../..");
const TRUTH_PATH = path.resolve(
   flag("truth") ?? path.join(ROOT, "evals/ground_truth.json"),
);
const TEXT_QUERIES_PATH = path.join(ROOT, "evals/text_queries.json");
const ROUNDS = Number(flag("rounds") ?? 3);
const KEEP_INDEX = process.argv.includes("--keep-index");

const EF_SEARCH = [10, 20, 40, 80, 160];
// (m, ef_construction) to build. 16:64 is pgvector's default.
const HNSW_CONFIGS = (flag("hnsw") ?? "16:64,16:200,32:200")
   .split(",")
   .map((c) => {
      const [m, ef_construction] = c.split(":").map(Number);
      if (!Number.isInteger(m) || !Number.isInteger(ef_construction))
         throw new Error(`bad --hnsw entry: ${c}`);
      return { m, ef_construction };
   });
const HYBRID = { candidates: 40, rrfK: 60, ef_search: 40 };
const INDEX = "idx_logs_embedding_hnsw";

interface Query {
   key: string; // log id or the free text
   text: string;
   vec: string; // pgvector literal
   expected: string | null;
   excludeId: number | null;
   kth_distance?: number;
}

type Setup = (trx: Conn) => Promise<void>;
type Run = (trx: Conn, q: Query) => Promise<Hit[]>;

interface MethodSpec {
   name: string;
   setup: Setup;
   run: Run;
   /** EXPLAIN must mention every one of these (proves which index was used)... */
   planMustHave?: string[];
   /** ...and none of these. */
   planMustNotHave?: string[];
}

interface MethodResult {
   method: string;
   builds?: number;
   recall_range?: [number, number];
   queries: number;
   recall_at_k: number | null;
   precision_at_k: number;
   latency_ms: { p50: number; p95: number; mean: number; samples: number };
   avg_results: number;
   empty_results: number;
   plan: string[];
   per_query: {
      key: string;
      recall: number | null;
      precision: number;
      results: number;
   }[];
   /** Raw latencies, kept in memory to pool across builds; not written out. */
   times?: number[];
}

/** Merges the same method measured on several builds of the index. */
function aggregate(runs: MethodResult[]): MethodResult {
   if (runs.length === 1) return runs[0];
   const times = runs.flatMap((r) => r.times ?? []);
   const recalls = runs
      .map((r) => r.recall_at_k)
      .filter((r): r is number => r !== null);
   return {
      ...runs[0],
      builds: runs.length,
      recall_at_k: recalls.length ? mean(recalls) : null,
      recall_range: recalls.length
         ? [Math.min(...recalls), Math.max(...recalls)]
         : undefined,
      precision_at_k: mean(runs.map((r) => r.precision_at_k)),
      latency_ms: {
         p50: ms(percentile(times, 50)),
         p95: ms(percentile(times, 95)),
         mean: ms(mean(times)),
         samples: times.length,
      },
      avg_results: mean(runs.map((r) => r.avg_results)),
      empty_results: Math.max(...runs.map((r) => r.empty_results)),
      per_query: runs[0].per_query.map((p, i) => {
         const rs = runs
            .map((r) => r.per_query[i].recall)
            .filter((x): x is number => x !== null);
         return {
            ...p,
            recall: rs.length ? mean(rs) : null,
            precision: mean(runs.map((r) => r.per_query[i].precision)),
         };
      }),
      times,
   };
}

const ms = (n: number) => Math.round(n * 1000) / 1000;
const fmtMs = (n: number) =>
   n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0);
const pct = (n: number | null) =>
   n === null ? "  -  " : `${(n * 100).toFixed(1)}%`.padStart(6);

const noIndexScans: Setup = async (trx) => {
   for (const s of [
      "enable_indexscan",
      "enable_bitmapscan",
      "enable_indexonlyscan",
   ])
      await trx.raw(`SET LOCAL ${s} = off`);
};
const efSearch =
   (ef: number): Setup =>
   async (trx) => {
      await trx.raw(`SET LOCAL hnsw.ef_search = ${Number(ef)}`);
      // Iterative scan (pgvector 0.8) is Phase 5's topic; pin it off so the
      // numbers here are plain HNSW whatever the server default is.
      await trx.raw("SET LOCAL hnsw.iterative_scan = off");
   };
const defaults: Setup = async () => {};

/** Captures the SQL of the first call, to EXPLAIN it with the same settings. */
async function explainFirst(
   trx: Conn,
   spec: MethodSpec,
   q: Query,
): Promise<string[]> {
   let captured: { sql: string; bindings: readonly any[] } | null = null;
   const spy = new Proxy(trx, {
      get(target: any, prop) {
         if (prop !== "raw") return target[prop];
         return (sql: string, bindings: any) => {
            const native = target.raw(sql, bindings).toSQL().toNative();
            captured = { sql: native.sql, bindings: native.bindings };
            return Promise.resolve({ rows: [] });
         };
      },
   });
   await spec.run(spy as Conn, q);
   if (!captured) return [];
   const c = captured as { sql: string; bindings: readonly any[] };
   const { rows } = await trx.raw(
      `EXPLAIN ${c.sql.replace(/\$(\d+)/g, "?")}`,
      c.bindings as any[],
   );
   return rows.map((r: any) => r["QUERY PLAN"]);
}

async function runMethod(
   spec: MethodSpec,
   queries: Query[],
   k: number,
): Promise<MethodResult> {
   return db.transaction(async (trx) => {
      await spec.setup(trx);
      const plan = await explainFirst(trx, spec, queries[0]);
      const text = plan.join("\n");
      for (const must of spec.planMustHave ?? []) {
         if (!text.includes(must))
            throw new Error(`${spec.name}: plan should use ${must}:\n${text}`);
      }
      for (const not of spec.planMustNotHave ?? []) {
         if (text.includes(not))
            throw new Error(
               `${spec.name}: plan should NOT use ${not}:\n${text}`,
            );
      }

      for (const q of queries) await spec.run(trx, q); // warm-up round, not measured
      const times: number[] = [];
      let results: Hit[][] = [];
      for (let r = 0; r < ROUNDS; r++) {
         results = [];
         for (const q of queries) {
            const t = performance.now();
            results.push(await spec.run(trx, q));
            times.push(performance.now() - t);
         }
      }

      // Recall needs each result's TRUE distance (exact, from the stored
      // vector), never the index's view of it.
      const perQuery: MethodResult["per_query"] = [];
      for (let i = 0; i < queries.length; i++) {
         const q = queries[i];
         const hits = results[i];
         let recall: number | null = null;
         if (q.kth_distance !== undefined) {
            const { rows } = await trx.raw(
               "SELECT id, embedding <=> ?::vector AS d FROM logs WHERE id = ANY(?::bigint[])",
               [q.vec, hits.map((h) => h.id)],
            );
            const d = new Map<number, number>(
               rows.map((r: any) => [Number(r.id), Number(r.d)]),
            );
            recall = recallAtK(
               hits.map((h) => ({ id: h.id, distance: d.get(h.id)! })),
               { id: q.excludeId ?? -1, kth_distance: q.kth_distance },
               k,
            );
         }
         perQuery.push({
            key: q.key,
            recall,
            precision: precisionAtK(
               hits.map((h) => h.root_cause),
               q.expected,
               k,
            ),
            results: hits.length,
         });
      }

      const recalls = perQuery
         .map((p) => p.recall)
         .filter((r): r is number => r !== null);
      return {
         method: spec.name,
         queries: queries.length,
         recall_at_k: recalls.length ? mean(recalls) : null,
         precision_at_k: mean(perQuery.map((p) => p.precision)),
         latency_ms: {
            p50: ms(percentile(times, 50)),
            p95: ms(percentile(times, 95)),
            mean: ms(mean(times)),
            samples: times.length,
         },
         avg_results: mean(perQuery.map((p) => p.results)),
         empty_results: perQuery.filter((p) => p.results === 0).length,
         plan,
         per_query: perQuery,
         times,
      };
   });
}

/**
 * maintenance_work_mem for the build. The graph is built in memory if it
 * fits (spilling is far slower), but a PARALLEL build allocates the whole
 * amount as shared memory up front, so oversizing it is not free either:
 * 4 GB on a 10k-row table made the build 13x slower here. ~4 KB per row
 * covers the graph (vector + neighbor lists) with margin.
 */
const buildMemoryMb = (rows: number) =>
   Math.min(4096, Math.max(64, Math.ceil((rows * 4) / 1024)));

async function buildHnsw(
   cfg: { m: number; ef_construction: number },
   rows: number,
) {
   await db.raw(`DROP INDEX IF EXISTS ${INDEX}`);
   const memoryMb = buildMemoryMb(rows);
   return db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL maintenance_work_mem = '${memoryMb}MB'`);
      await trx.raw("SET LOCAL max_parallel_maintenance_workers = 3");
      const t = performance.now();
      await trx.raw(
         `CREATE INDEX ${INDEX} ON logs USING hnsw (embedding vector_cosine_ops)
          WITH (m = ${cfg.m}, ef_construction = ${cfg.ef_construction})`,
      );
      const buildMs = performance.now() - t;
      const {
         rows: [s],
      } = await trx.raw(
         `SELECT pg_relation_size(?::regclass) AS hnsw, pg_relation_size('idx_logs_message_fts') AS gin,
                 pg_relation_size('logs') AS heap, pg_total_relation_size('logs') AS total`,
         [INDEX],
      );
      return {
         ...cfg,
         maintenance_work_mem_mb: memoryMb,
         build_ms: Math.round(buildMs),
         size_bytes: {
            hnsw: Number(s.hnsw),
            gin: Number(s.gin),
            table_heap: Number(s.heap),
            table_total: Number(s.total),
         },
      };
   });
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function printTable(title: string, rows: MethodResult[]) {
   console.log(`\n${title}`);
   console.log(
      `${"method".padEnd(34)} recall@10 [min-max]     prec@10     p50 ms     p95 ms  avg n  empty`,
   );
   for (const r of rows) {
      const range = r.recall_range
         ? `[${(r.recall_range[0] * 100).toFixed(0)}-${(r.recall_range[1] * 100).toFixed(0)}]`
         : "";
      console.log(
         `${r.method.padEnd(34)} ${pct(r.recall_at_k).padStart(9)} ${range.padEnd(11)}  ${pct(r.precision_at_k).padStart(7)}` +
            `  ${fmtMs(r.latency_ms.p50).padStart(9)}  ${fmtMs(r.latency_ms.p95).padStart(9)}` +
            `  ${r.avg_results.toFixed(1).padStart(5)}  ${String(r.empty_results).padStart(5)}`,
      );
   }
}

async function main() {
   const truth: GroundTruth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
   const k = truth.k;

   const {
      rows: [fp],
   } = await db.raw(
      "SELECT count(*) AS rows, md5(string_agg(id || ':' || md5(embedding::text), ',' ORDER BY id)) AS fingerprint FROM logs",
   );
   if (fp.fingerprint !== truth.fingerprint) {
      throw new Error(
         `${path.relative(ROOT, TRUTH_PATH)} is stale for this table (${fp.rows} rows); run pnpm eval:ground-truth`,
      );
   }
   const rows = Number(fp.rows);
   const repeats = Number(flag("repeats") ?? (rows <= 100_000 ? 3 : 1));
   console.log(
      `${rows.toLocaleString("en-US")} rows, ${truth.queries.length} log queries, k=${k}, ${ROUNDS} measured rounds`,
   );

   const { rows: vecRows } = await db.raw(
      "SELECT id, embedding::text AS e FROM logs WHERE id = ANY(?::bigint[])",
      [truth.queries.map((q) => q.id)],
   );
   const vecById = new Map<number, string>(
      vecRows.map((r: any) => [Number(r.id), r.e as string]),
   );
   const logQueries: Query[] = truth.queries.map((q) => ({
      key: String(q.id),
      text: q.message,
      vec: vecById.get(q.id)!,
      expected: q.root_cause,
      excludeId: q.id,
      kth_distance: q.kth_distance,
   }));

   const textSpec: { text: string; expected: string; kind: string }[] =
      JSON.parse(readFileSync(TEXT_QUERIES_PATH, "utf8")).queries;
   const embedTimes: number[] = [];
   const textQueries: Query[] = [];
   for (const t of textSpec) {
      const start = performance.now();
      const [v] = await embed([t.text]);
      embedTimes.push(performance.now() - start);
      textQueries.push({
         key: t.text,
         text: t.text,
         vec: toPgVector(v),
         expected: t.expected,
         excludeId: null,
      });
   }
   // Exact k-th distance for each free-text query (forced sequential scan).
   await db.transaction(async (trx) => {
      await noIndexScans(trx);
      for (const q of textQueries) {
         const { rows: r } = await trx.raw(
            "SELECT embedding <=> :vec::vector AS d FROM logs ORDER BY embedding <=> :vec::vector, id LIMIT 1 OFFSET :off",
            { vec: q.vec, off: k - 1 },
         );
         q.kth_distance = Number(r[0].d);
      }
   });

   // --- 1 & 2: no ANN index yet ---------------------------------------------
   await db.raw(`DROP INDEX IF EXISTS ${INDEX}`);
   const like: MethodSpec = {
      name: "LIKE (no index)",
      setup: defaults,
      run: (c, q) =>
         likeSearch(
            c,
            q.excludeId === null
               ? likePattern(q.text, 99)
               : likePattern(q.text),
            k,
            q.excludeId,
         ),
   };
   const fts: MethodSpec = {
      name: "full-text (GIN)",
      setup: defaults,
      run: (c, q) => fullTextSearch(c, q.text, k, q.excludeId),
      planMustHave: ["idx_logs_message_fts"],
   };
   const exact: MethodSpec = {
      name: "vector exact (seq)",
      setup: noIndexScans,
      run: (c, q) => vectorSearch(c, q.vec, k, q.excludeId),
      planMustHave: ["Seq Scan on logs"],
      planMustNotHave: [INDEX],
   };

   const logResults: MethodResult[] = [];
   const textResults: MethodResult[] = [];
   for (const spec of [like, fts, exact]) {
      process.stdout.write(`running ${spec.name}...`);
      logResults.push(await runMethod(spec, logQueries, k));
      textResults.push(await runMethod(spec, textQueries, k));
      console.log(" done");
   }

   // --- 3 & 4: HNSW (per build config) and hybrid ----------------------------
   const builds = [];
   let hybridName = "";
   for (const cfg of HNSW_CONFIGS) {
      const tag = `m=${cfg.m} efc=${cfg.ef_construction}`;
      const logRuns = new Map<string, MethodResult[]>();
      const textRuns = new Map<string, MethodResult[]>();
      for (let b = 1; b <= repeats; b++) {
         process.stdout.write(`building HNSW (${tag}) ${b}/${repeats}...`);
         const build = await buildHnsw(cfg, rows);
         builds.push({ ...build, repeat: b });
         console.log(
            ` ${(build.build_ms / 1000).toFixed(1)}s, ${mb(build.size_bytes.hnsw)}`,
         );

         const specs: MethodSpec[] = EF_SEARCH.map((ef) => ({
            name: `HNSW ${tag} ef_search=${ef}`,
            setup: efSearch(ef),
            run: (c, q) => vectorSearch(c, q.vec, k, q.excludeId),
            planMustHave: [INDEX],
         }));
         // RRF over the GIN top-N and this index's top-N, in one statement.
         hybridName = `hybrid RRF (${tag} ef=${HYBRID.ef_search})`;
         specs.push({
            name: hybridName,
            setup: efSearch(HYBRID.ef_search),
            run: (c, q) =>
               hybridSearch(c, q.text, q.vec, k, q.excludeId, HYBRID),
            planMustHave: [INDEX, "idx_logs_message_fts"],
         });
         for (const spec of specs) {
            process.stdout.write(`  ${spec.name}...`);
            logRuns.set(spec.name, [
               ...(logRuns.get(spec.name) ?? []),
               await runMethod(spec, logQueries, k),
            ]);
            textRuns.set(spec.name, [
               ...(textRuns.get(spec.name) ?? []),
               await runMethod(spec, textQueries, k),
            ]);
            console.log(" done");
         }
      }
      for (const runs of logRuns.values()) logResults.push(aggregate(runs));
      for (const runs of textRuns.values()) textResults.push(aggregate(runs));
   }

   if (!KEEP_INDEX) await db.raw(`DROP INDEX IF EXISTS ${INDEX}`);

   // --- report ----------------------------------------------------------------
   printTable(
      `LOG QUERIES (${logQueries.length} logs from the ground truth; recall vs exact search)`,
      logResults,
   );
   printTable(
      `FREE-TEXT QUERIES (${textQueries.length}, evals/text_queries.json; recall vs exact, precision by root_cause)`,
      textResults,
   );
   console.log(
      `\nHNSW builds (maintenance_work_mem ${builds[0].maintenance_work_mem_mb} MB, 3 parallel workers):`,
   );
   for (const b of builds) {
      console.log(
         `  m=${b.m} efc=${b.ef_construction} #${b.repeat}: ${(b.build_ms / 1000).toFixed(1)}s, ${mb(b.size_bytes.hnsw)}`,
      );
   }
   console.log(
      `  (table heap ${mb(builds[0].size_bytes.table_heap)}, GIN ${mb(builds[0].size_bytes.gin)})`,
   );
   console.log(
      `\nembedding a free-text query: p50 ${fmtMs(percentile(embedTimes, 50))} ms (${MODEL_ID}, CPU)`,
   );

   const pick = (rs: MethodResult[], name: string) =>
      rs.find((r) => r.method === name)!;
   const last = HNSW_CONFIGS[HNSW_CONFIGS.length - 1];
   const hnsw40 = `HNSW m=${last.m} efc=${last.ef_construction} ef_search=40`;
   console.log(
      `\nfree-text precision@${k} by kind (vector/hybrid: ${hnsw40.replace("HNSW ", "")}):`,
   );
   console.log("kind        n    LIKE     fts  exact   hnsw  hybrid");
   for (const kind of ["keyword", "mixed", "paraphrase"]) {
      const idx = textSpec
         .map((t, i) => (t.kind === kind ? i : -1))
         .filter((i) => i >= 0);
      const p = (name: string) =>
         pct(
            mean(
               idx.map((i) => pick(textResults, name).per_query[i].precision),
            ),
         );
      console.log(
         `${kind.padEnd(10)} ${String(idx.length).padStart(2)}  ${p(like.name)} ${p(fts.name)} ${p(exact.name)} ${p(hnsw40)} ${p(hybridName)}`,
      );
   }
   console.log(`\nwhere each one wins (precision@${k}, free text):`);
   textSpec.forEach((t, i) => {
      const f = pick(textResults, fts.name).per_query[i].precision;
      const v = pick(textResults, exact.name).per_query[i].precision;
      const h = pick(textResults, hybridName).per_query[i].precision;
      if (Math.abs(f - v) >= 0.5) {
         console.log(
            `  ${(f > v ? "keywords" : "vectors ").padEnd(9)} fts ${pct(f)} exact-vector ${pct(v)} hybrid ${pct(h)}  [${t.kind}] ${t.text}`,
         );
      }
   });

   const outDir = path.join(ROOT, "evals/results");
   mkdirSync(outDir, { recursive: true });
   const out = path.join(
      outDir,
      `search-${rows >= 1_000_000 ? `${rows / 1_000_000}m` : `${rows / 1000}k`}.json`,
   );
   writeFileSync(
      out,
      JSON.stringify(
         {
            created_at: new Date().toISOString(),
            rows,
            fingerprint: fp.fingerprint,
            ground_truth: path.relative(ROOT, TRUTH_PATH),
            model: MODEL_ID,
            k,
            rounds: ROUNDS,
            latency_note:
               "client-side wall time per query over a local socket, warm cache, after one warm-up round",
            hnsw_builds: builds,
            hybrid: HYBRID,
            embed_query_ms: {
               p50: ms(percentile(embedTimes, 50)),
               p95: ms(percentile(embedTimes, 95)),
            },
            repeats,
            log_queries: logResults.map(({ times, ...r }) => r),
            text_queries: textResults.map(({ times, ...r }) => ({
               ...r,
               per_query: r.per_query.map((p, i) => ({
                  ...p,
                  kind: textSpec[i].kind,
                  expected: textSpec[i].expected,
               })),
            })),
         },
         null,
         2,
      ) + "\n",
   );
   console.log(`\nwrote ${path.relative(ROOT, out)}`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
