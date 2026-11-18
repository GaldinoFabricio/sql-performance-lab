import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Knex } from "knex";
import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { mean, percentile, recallAtK } from "../evals/metrics";

/**
 * Full HNSW index vs a partial one without INFO logs, on the 60 typed
 * queries (evals/text_queries.json).
 *
 * Every typed query is about an incident (a WARN, ERROR or FATAL root cause),
 * while INFO logs are ~74% of the table. A partial index
 *    CREATE INDEX … USING hnsw (embedding …) WHERE level <> 'INFO'
 * holds a quarter of the rows: a smaller graph to build and to walk, no INFO
 * cluster for the walk to get stuck in, and no HNSW cost on INFO inserts.
 * The price: a query must say WHERE level <> 'INFO' to use it, and INFO
 * logs are no longer reachable through the index.
 *
 * Methods, each with top-10 recall (tie-aware) and precision by root_cause:
 *   exact, all rows          : the old ceiling (seq scan, no index)
 *   exact, not INFO          : the new ceiling, and the truth for the filtered methods
 *   full HNSW                : the production index, no filter
 *   full HNSW + filter       : WHERE level <> 'INFO' applied after the walk
 *                              (iterative scan off: the classic post-filter problem)
 *   full HNSW + filter, iter : same with hnsw.iterative_scan = strict_order
 *   partial HNSW             : the index above, WHERE level <> 'INFO'
 *
 * Write cost: WAL bytes and time per INSERT of INFO and non-INFO rows with
 * the full index only, the partial index only, and no HNSW index. Each case
 * runs in a transaction that drops the other indexes and is rolled back, so
 * nothing is rebuilt and the production index is untouched.
 *
 * The partial index (the production one since migration 20261118120000) is
 * built --rebuild=N times (default 1; HNSW levels are random, so builds
 * differ). If it existed before the run, the last build stays; otherwise it
 * is dropped at the end unless --keep-index.
 * The full index is the existing one; --rebuild-full=N rebuilds it N times
 * (slow at 1M). --skip-full skips the full-index methods.
 *
 * Usage: pnpm eval:partial-hnsw [--rebuild=3] [--rebuild-full=3] [--write-rows=500]
 *                               [--rounds=3] [--skip-full] [--keep-index] [--out=…]
 */

type Conn = Knex | Knex.Transaction;
interface TextQuery { text: string; expected: string; kind: string }
interface Row { id: number; root_cause: string; distance: number }
type How = { name: string; filter: boolean; ef: number | null; iterative?: boolean; index?: string };
interface Measured { recall: number; precision: number; results: number; ms: number }

const ROOT = path.resolve(__dirname, "../..");
const K = 10;
const EF = [40, 160] as const;
const KINDS = ["keyword", "mixed", "paraphrase"] as const;
const FULL = "idx_logs_embedding_hnsw";
const PARTIAL = "idx_logs_embedding_hnsw_not_info";
const PREDICATE = "level <> 'INFO'";
// Same as migration 20261115130000_add_logs_embedding_hnsw_index.ts.
const M = 32;
const EF_CONSTRUCTION = 200;

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name: string) => process.argv.includes(`--${name}`);
const partialBuilds = Number(flag("rebuild") ?? 1);
const fullRebuilds = Number(flag("rebuild-full") ?? 0);
const writeRows = Number(flag("write-rows") ?? 500);
const ROUNDS = Number(flag("rounds") ?? 3);
const SKIP_FULL = has("skip-full");
const KEEP = has("keep-index");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const minMax = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

const sql = (filter: boolean) =>
   `SELECT id, root_cause, embedding <=> :vec::vector AS distance FROM logs
    ${filter ? `WHERE ${PREDICATE}` : ""} ORDER BY embedding <=> :vec::vector LIMIT ${K}`;

async function setup(trx: Conn, how: How) {
   if (how.ef === null) {
      // exact: no index of any kind, as in evals/README.md
      for (const s of ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"]) await trx.raw(`SET LOCAL ${s} = off`);
   } else {
      await trx.raw(`SET LOCAL hnsw.ef_search = ${how.ef}`);
      await trx.raw(`SET LOCAL hnsw.iterative_scan = ${how.iterative ? "strict_order" : "off"}`);
   }
}

async function search(vec: string, how: How): Promise<{ rows: Row[]; ms: number }> {
   const t = performance.now();
   const rows = await db.transaction(async (trx) => {
      await setup(trx, how);
      const { rows } = await trx.raw(sql(how.filter), { vec });
      return rows.map((r: any) => ({ id: Number(r.id), root_cause: r.root_cause, distance: Number(r.distance) }));
   });
   return { rows, ms: performance.now() - t };
}

/** Fails the run if the planner did not use the index (or the seq scan) the method is about. */
async function checkPlan(vec: string, how: How) {
   const names = await db.transaction(async (trx) => {
      await setup(trx, how);
      const { rows } = await trx.raw(`EXPLAIN (FORMAT JSON) ${sql(how.filter)}`, { vec });
      const out: string[] = [];
      const walk = (n: any) => { out.push(n["Node Type"] + (n["Index Name"] ? ` (${n["Index Name"]})` : "")); (n.Plans ?? []).forEach(walk); };
      walk(rows[0]["QUERY PLAN"][0].Plan);
      return out;
   });
   const ok = how.index ? names.some((n) => n.includes(`(${how.index})`)) : names.some((n) => n.includes("Seq Scan"));
   if (!ok) throw new Error(`${how.name}: expected ${how.index ?? "Seq Scan"}, got ${names.join(" → ")}`);
   return names.join(" → ");
}

async function buildIndex(name: string, where: string | null, rows: number) {
   // ~4 KB per indexed row keeps the graph in memory, as in the migration.
   const memMb = Math.min(4096, Math.max(64, Math.ceil((rows * 4) / 1024)));
   const t = performance.now();
   await db.transaction(async (trx) => {
      await trx.raw(`DROP INDEX IF EXISTS ${name}`);
      await trx.raw(`SET LOCAL maintenance_work_mem = '${memMb}MB'`);
      await trx.raw(
         `CREATE INDEX ${name} ON logs USING hnsw (embedding vector_cosine_ops)
          WITH (m = ${M}, ef_construction = ${EF_CONSTRUCTION}) ${where ? `WHERE ${where}` : ""}`,
      );
   });
   const s = (performance.now() - t) / 1000;
   // The build writes the whole index to WAL; the checkpoint that follows
   // would otherwise land in the middle of the next measurement.
   await db.raw("CHECKPOINT").catch(() => console.warn("CHECKPOINT needs superuser; latencies right after a build may be noisy"));
   return s;
}

const indexBytes = async (name: string) =>
   Number((await db.raw("SELECT coalesce(pg_relation_size(to_regclass(?)), 0) AS b", [name])).rows[0].b);

type Q = TextQuery & { vec: string; kthAll: number; kthNotInfo: number };

/**
 * Per-query recall, precision, result count and time: a warm-up pass, then
 * ROUNDS passes; the time is the per-query median, the results those of the last pass.
 */
async function measure(queries: Q[], how: How): Promise<Measured[]> {
   for (const q of queries) await search(q.vec, how); // warm-up
   const times: number[][] = queries.map(() => []);
   let last: Row[][] = [];
   for (let r = 0; r < ROUNDS; r++) {
      last = [];
      for (const [i, q] of queries.entries()) {
         const { rows, ms } = await search(q.vec, how);
         times[i].push(ms);
         last.push(rows);
      }
   }
   const out: Measured[] = [];
   for (const [i, q] of queries.entries()) {
      const rows = last[i];
      const ms = percentile(times[i], 50);
      const kth = how.filter ? q.kthNotInfo : q.kthAll;
      out.push({
         recall: recallAtK(rows, { id: -1, kth_distance: kth }, K),
         precision: rows.filter((r) => r.root_cause === q.expected).length / K,
         results: rows.length,
         ms,
      });
   }
   return out;
}

/** INSERT cost of n copied rows of one kind, with only `keep` HNSW indexes present; rolled back. */
async function writeCost(keep: string[], info: boolean, n: number) {
   const trx = await db.transaction();
   try {
      for (const idx of [FULL, PARTIAL]) if (!keep.includes(idx)) await trx.raw(`DROP INDEX IF EXISTS ${idx}`);
      const { rows: [a] } = await trx.raw("SELECT pg_current_wal_insert_lsn() AS lsn");
      const t = performance.now();
      await trx.raw(
         `INSERT INTO logs (created_at, service, level, error_code, message, root_cause, embedding)
          SELECT created_at, service, level, error_code, message, root_cause, embedding
          FROM logs WHERE ${info ? "level = 'INFO'" : PREDICATE} ORDER BY id LIMIT ?`,
         [n],
      );
      const ms = performance.now() - t;
      const { rows: [b] } = await trx.raw("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ?) AS bytes", [a.lsn]);
      return { wal_bytes_per_row: Number(b.bytes) / n, rows_per_s: n / (ms / 1000) };
   } finally {
      await trx.rollback();
   }
}

async function main() {
   const textQueries: TextQuery[] = JSON.parse(readFileSync(path.join(ROOT, "evals/text_queries.json"), "utf8")).queries;
   const { rows: [info] } = await db.raw(
      `SELECT count(*)::int AS rows, count(embedding)::int AS embedded,
              count(*) FILTER (WHERE ${PREDICATE})::int AS not_info,
              to_regclass(:full) IS NOT NULL AS has_full,
              to_regclass(:partial) IS NOT NULL AS has_partial FROM logs`,
      { full: FULL, partial: PARTIAL },
   );
   if (info.rows === 0 || info.embedded !== info.rows) throw new Error("run pnpm seed:logs and pnpm embed:logs first");
   if (!SKIP_FULL && !info.has_full && fullRebuilds === 0) throw new Error(`${FULL} is missing: run pnpm migrate, pass --rebuild-full=1 or --skip-full`);
   const size = info.rows >= 1_000_000 ? `${info.rows / 1_000_000}m` : `${info.rows / 1000}k`;
   console.log(
      `logs: ${info.rows.toLocaleString()} rows, ${info.not_info.toLocaleString()} not INFO (${pct(info.not_info / info.rows)}); ` +
         `HNSW m=${M} ef_construction=${EF_CONSTRUCTION}, top-${K}\n`,
   );

   // Exact results don't depend on any index: the k-th distances are computed once.
   const queries: Q[] = [];
   for (const q of textQueries) {
      const vec = toPgVector((await embed([q.text]))[0]);
      const all = await search(vec, { name: "exact", filter: false, ef: null });
      const notInfo = await search(vec, { name: "exact", filter: true, ef: null });
      queries.push({ ...q, vec, kthAll: all.rows[K - 1].distance, kthNotInfo: notInfo.rows[K - 1].distance });
   }

   // The partial index must not exist while the full one is measured, or the
   // planner may pick it for the filtered queries.
   await db.raw(`DROP INDEX IF EXISTS ${PARTIAL}`);

   const methods: Record<string, { how: How; plan?: string; builds: Measured[][]; build_s: (number | null)[]; index_bytes?: number }> = {};
   const run = async (how: How, build_s: number | null) => {
      const m = (methods[how.name] ??= { how, builds: [], build_s: [] });
      m.plan ??= await checkPlan(queries[0].vec, how);
      m.builds.push(await measure(queries, how));
      m.build_s.push(build_s);
   };

   await run({ name: "exact, all rows", filter: false, ef: null }, null);
   await run({ name: "exact, not INFO", filter: true, ef: null }, null);

   if (!SKIP_FULL) {
      for (let b = 0; b < Math.max(1, fullRebuilds); b++) {
         const s = fullRebuilds > 0 ? await buildIndex(FULL, null, info.rows) : null;
         if (s !== null) console.log(`full index build ${b + 1}: ${s.toFixed(1)} s`);
         for (const ef of EF) {
            await run({ name: `full HNSW, ef_search=${ef}`, filter: false, ef, index: FULL }, s);
            await run({ name: `full HNSW + filter, ef_search=${ef}`, filter: true, ef, index: FULL }, s);
            await run({ name: `full HNSW + filter, iterative, ef_search=${ef}`, filter: true, ef, iterative: true, index: FULL }, s);
         }
      }
      const bytes = await indexBytes(FULL);
      for (const m of Object.values(methods)) if (m.how.index === FULL) m.index_bytes = bytes;
   }

   for (let b = 0; b < partialBuilds; b++) {
      const s = await buildIndex(PARTIAL, PREDICATE, info.not_info);
      console.log(`partial index build ${b + 1}: ${s.toFixed(1)} s`);
      for (const ef of EF) await run({ name: `partial HNSW, ef_search=${ef}`, filter: true, ef, index: PARTIAL }, s);
   }
   const partialBytes = await indexBytes(PARTIAL);
   for (const m of Object.values(methods)) if (m.how.index === PARTIAL) m.index_bytes = partialBytes;

   // ---- write cost ----
   const scenarios: [string, string[]][] = [["no HNSW", []], ["partial only", [PARTIAL]]];
   if (!SKIP_FULL) scenarios.splice(1, 0, ["full only", [FULL]]);
   const writes: Record<string, Record<string, ReturnType<typeof writeCost> extends Promise<infer T> ? T : never>> = {};
   for (const [name, keep] of scenarios) {
      writes[name] = {};
      for (const kind of ["INFO", "not INFO"] as const) {
         await writeCost(keep, kind === "INFO", writeRows); // warm-up
         writes[name][kind] = await writeCost(keep, kind === "INFO", writeRows);
      }
   }

   // ---- report ----
   const groups = [
      { kind: "all", idx: queries.map((_, i) => i) },
      ...KINDS.map((kind) => ({ kind, idx: queries.flatMap((q, i) => (q.kind === kind ? [i] : [])) })),
   ];
   const summary = Object.entries(methods).map(([name, m]) => {
      const per = (f: (x: Measured) => number, idx: number[]) => m.builds.map((b) => mean(idx.map((i) => f(b[i]))));
      const recall = per((x) => x.recall, groups[0].idx);
      const precision = per((x) => x.precision, groups[0].idx);
      const ms = m.builds.flat().map((x) => x.ms);
      return {
         method: name,
         builds: m.builds.length,
         build_s: m.build_s,
         index_bytes: m.index_bytes ?? null,
         plan: m.plan,
         recall: mean(recall),
         recall_range: minMax(recall),
         precision: mean(precision),
         precision_range: minMax(precision),
         by_kind: Object.fromEntries(groups.slice(1).map((g) => [g.kind, mean(per((x) => x.precision, g.idx))])),
         short_results: minMax(m.builds.map((b) => b.filter((x) => x.results < K).length)), // queries with < k rows back
         zero_relevant: minMax(m.builds.map((b) => b.filter((x) => x.precision === 0).length)),
         p50_ms: percentile(ms, 50),
         p95_ms: percentile(ms, 95),
      };
   });

   const range = (r: [number, number], f: (x: number) => string) => (r[0] === r[1] ? "" : ` (${f(r[0])}–${f(r[1])})`);
   const n0 = (x: number) => (x * 100).toFixed(0);
   const lohi = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`);
   console.log(`\n${"method".padEnd(44)}${"recall@10".padEnd(18)}${"precision@10".padEnd(18)}${"<10 rows".padEnd(10)}${"0 relevant".padEnd(12)}${"p50 ms".padEnd(9)}p95 ms`);
   for (const s of summary) {
      console.log(
         s.method.padEnd(44) +
            `${pct(s.recall)}${range(s.recall_range, n0)}`.padEnd(18) +
            `${pct(s.precision)}${range(s.precision_range, n0)}`.padEnd(18) +
            lohi(s.short_results).padEnd(10) +
            lohi(s.zero_relevant).padEnd(12) +
            s.p50_ms.toFixed(2).padEnd(9) +
            s.p95_ms.toFixed(2),
      );
   }
   console.log(`\nprecision by kind: ${summary.map((s) => `\n  ${s.method.padEnd(42)}${KINDS.map((k) => `${k} ${pct(s.by_kind[k])}`).join("  ")}`).join("")}`);
   const fullBuild = methods[`full HNSW, ef_search=${EF[0]}`]?.build_s.filter((x): x is number => x !== null) ?? [];
   console.log(
      `\nindex: full ${SKIP_FULL ? "skipped" : mb(await indexBytes(FULL))}${fullBuild.length ? `, built in ${fullBuild.map((s) => `${s.toFixed(1)}s`).join(", ")}` : ""}; ` +
         `partial ${mb(partialBytes)}, built in ${methods[`partial HNSW, ef_search=${EF[0]}`].build_s.map((s) => `${s!.toFixed(1)}s`).join(", ")}`,
   );
   console.log(`\nINSERT of ${writeRows} copied rows (rolled back):`);
   for (const [name, w] of Object.entries(writes)) {
      console.log(
         `  ${name.padEnd(14)}` +
            Object.entries(w).map(([kind, x]) => `${kind}: ${Math.round(x.wal_bytes_per_row).toLocaleString()} B WAL/row, ${Math.round(x.rows_per_s).toLocaleString()} rows/s`.padEnd(48)).join(""),
      );
   }

   const keep = KEEP || info.has_partial; // never drop the production index
   if (!keep) await db.raw(`DROP INDEX IF EXISTS ${PARTIAL}`);

   const out = flag("out") ? path.resolve(ROOT, flag("out")!) : path.join(ROOT, `evals/results/partial-hnsw-${size}.json`);
   mkdirSync(path.dirname(out), { recursive: true });
   writeFileSync(
      out,
      JSON.stringify(
         {
            created_at: new Date().toISOString(),
            rows: info.rows,
            not_info_rows: info.not_info,
            index: { m: M, ef_construction: EF_CONSTRUCTION, partial_predicate: PREDICATE },
            k: K,
            latency_note: `client-side wall time per query (one transaction with SET LOCAL), median of ${ROUNDS} passes after a warm-up pass, CHECKPOINT after each build`,
            summary,
            writes: { rows: writeRows, ...writes },
            per_query: queries.map((q, i) => ({
               text: q.text, kind: q.kind, expected: q.expected,
               kth_distance_all: q.kthAll, kth_distance_not_info: q.kthNotInfo,
               methods: Object.fromEntries(Object.entries(methods).map(([name, m]) => [name, m.builds.map((b) => ({ recall: b[i].recall, precision: b[i].precision }))])),
            })),
         },
         null,
         2,
      ),
   );
   console.log(`\nwrote ${path.relative(ROOT, out)}${keep ? ` (kept ${PARTIAL})` : ""}`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
