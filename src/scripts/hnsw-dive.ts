import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Knex } from "knex";
import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { mean, recallAtK } from "../evals/metrics";

/**
 * Exact search vs HNSW, up close, on the 60 typed queries (evals/text_queries.json).
 *
 * pnpm eval:search answers "which config is best?" with averages. This script
 * answers "what is HNSW actually doing?":
 *   1. recall and precision per kind of query, at ef_search 40 and 160,
 *      on one or more builds of the index (--rebuild=N) to show build noise;
 *   2. a deep dive on a few queries: EXPLAIN (ANALYZE, BUFFERS) for exact and
 *      HNSW (time, pages read, plan), and the logs HNSW missed next to what
 *      it returned instead.
 *
 * Two ways a vector search fails, and the deep dive separates them:
 *   - the INDEX failed: exact search finds relevant logs, HNSW does not
 *     (low recall). Fix: ef_search, m / ef_construction, or exact search;
 *   - the MODEL failed: exact search finds nothing relevant either
 *     (precision 0 with recall 100%). No index setting helps; use full-text
 *     or hybrid.
 *
 * Works at any table size. Needs embedded logs and idx_logs_embedding_hnsw.
 * --rebuild=N drops and rebuilds the index N times with the migration's
 * parameters (m = 32, ef_construction = 200) and measures each build; HNSW
 * draws each node's level at random, so two builds give different graphs.
 * The last build is left in place.
 *
 * Usage: pnpm eval:hnsw-dive [--rebuild=3] [--out=evals/results/hnsw-dive-100k.json]
 */

type Conn = Knex | Knex.Transaction;
interface TextQuery { text: string; expected: string; kind: string }
interface Row { id: number; root_cause: string; message: string; distance: number }
type Query = TextQuery & { vec: string; exact: Row[]; exactPrecision: number };

const ROOT = path.resolve(__dirname, "../..");
const K = 10;
const EF = [40, 160] as const;
const KINDS = ["keyword", "mixed", "paraphrase"] as const;
const INDEX = "idx_logs_embedding_hnsw";
// Same as migration 20261115130000_add_logs_embedding_hnsw_index.ts.
const M = 32;
const EF_CONSTRUCTION = 200;

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const rebuilds = Number(flag("rebuild") ?? 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const minMax = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];

const SQL = `SELECT id, root_cause, message, embedding <=> :vec::vector AS distance
             FROM logs ORDER BY embedding <=> :vec::vector LIMIT ${K}`;

// Exact = no index of any kind, as in evals/README.md; HNSW = the index with a given ef_search.
async function setup(trx: Conn, how: "exact" | number) {
   if (how === "exact") {
      for (const s of ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"]) {
         await trx.raw(`SET LOCAL ${s} = off`);
      }
   } else {
      await trx.raw(`SET LOCAL hnsw.ef_search = ${how}`);
      await trx.raw("SET LOCAL hnsw.iterative_scan = off");
   }
}

async function search(vec: string, how: "exact" | number): Promise<Row[]> {
   return db.transaction(async (trx) => {
      await setup(trx, how);
      const { rows } = await trx.raw(SQL, { vec });
      return rows.map((r: any) => ({ ...r, id: Number(r.id), distance: Number(r.distance) }));
   });
}

async function explain(vec: string, how: "exact" | number) {
   return db.transaction(async (trx) => {
      await setup(trx, how);
      const { rows } = await trx.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SQL}`, { vec });
      const plan = rows[0]["QUERY PLAN"][0];
      const nodes: any[] = [];
      const walk = (n: any) => { nodes.push(n); (n.Plans ?? []).forEach(walk); };
      walk(plan.Plan);
      const names = nodes.map((n) => n["Node Type"] + (n["Index Name"] ? ` (${n["Index Name"]})` : ""));
      if (how === "exact" && !names.includes("Seq Scan")) throw new Error(`exact search did not seq scan: ${names}`);
      if (how !== "exact" && !names.some((n) => n.includes(INDEX))) throw new Error(`HNSW not used: ${names}`);
      return {
         ms: plan["Execution Time"] as number,
         pages: { hit: plan.Plan["Shared Hit Blocks"] as number, read: plan.Plan["Shared Read Blocks"] as number },
         workers: nodes.find((n) => n["Workers Launched"] !== undefined)?.["Workers Launched"] ?? 0,
         plan: names.join(" → "),
      };
   });
}

async function rebuild(rows: number) {
   // ~4 KB per row keeps the graph in memory, as in the migration.
   const mb = Math.min(4096, Math.max(64, Math.ceil((rows * 4) / 1024)));
   const t = performance.now();
   await db.transaction(async (trx) => {
      await trx.raw(`DROP INDEX IF EXISTS ${INDEX}`);
      await trx.raw(`SET LOCAL maintenance_work_mem = '${mb}MB'`);
      await trx.raw(
         `CREATE INDEX ${INDEX} ON logs USING hnsw (embedding vector_cosine_ops)
          WITH (m = ${M}, ef_construction = ${EF_CONSTRUCTION})`,
      );
   });
   return (performance.now() - t) / 1000;
}

/** One query against the current index, at each ef_search. */
async function measure(q: TextQuery & { vec: string; exact: Row[] }) {
   const kth = q.exact[K - 1].distance;
   const out: Record<string, { recall: number; precision: number; hits: Row[] }> = {};
   for (const ef of EF) {
      const hits = await search(q.vec, ef);
      out[`ef${ef}`] = {
         recall: recallAtK(hits, { id: -1, kth_distance: kth }, K), // tie-aware, as in eval:search
         precision: hits.filter((h) => h.root_cause === q.expected).length / K,
         hits,
      };
   }
   return out;
}

async function main() {
   const queries: TextQuery[] = JSON.parse(readFileSync(path.join(ROOT, "evals/text_queries.json"), "utf8")).queries;
   const { rows: [info] } = await db.raw(
      `SELECT count(*)::int AS rows, count(embedding)::int AS embedded,
              to_regclass(:idx) IS NOT NULL AS has_index FROM logs`,
      { idx: INDEX },
   );
   if (info.rows === 0 || info.embedded !== info.rows) throw new Error("run pnpm seed:logs and pnpm embed:logs first");
   if (!info.has_index && rebuilds === 0) throw new Error(`${INDEX} is missing: run pnpm migrate or pass --rebuild=1`);
   const size = info.rows >= 1_000_000 ? `${info.rows / 1_000_000}m` : `${info.rows / 1000}k`;
   console.log(`logs: ${info.rows.toLocaleString()} rows, HNSW m=${M} ef_construction=${EF_CONSTRUCTION}, top-${K}\n`);

   // Exact results don't depend on the index: compute them once.
   const base: Query[] = [];
   for (const q of queries) {
      const vec = toPgVector((await embed([q.text]))[0]);
      const exact = await search(vec, "exact");
      base.push({ ...q, vec, exact, exactPrecision: exact.filter((r) => r.root_cause === q.expected).length / K });
   }

   // ---- 1. averages, per build ----
   const builds: { build_s: number | null; per: Awaited<ReturnType<typeof measure>>[] }[] = [];
   for (let b = 0; b < Math.max(1, rebuilds); b++) {
      const build_s = rebuilds > 0 ? await rebuild(info.rows) : null;
      const per = [];
      for (const q of base) per.push(await measure(q));
      builds.push({ build_s, per });
   }
   const { rows: [sizes] } = await db.raw(
      "SELECT pg_relation_size('logs') AS heap, pg_relation_size(:idx) AS index",
      { idx: INDEX },
   );

   const groups = [{ kind: "all", idx: base.map((_, i) => i) }, ...KINDS.map((kind) => ({ kind, idx: base.flatMap((q, i) => (q.kind === kind ? [i] : [])) }))];
   const summary: Record<string, any> = {};
   console.log(`1) ${builds.length} build(s)${rebuilds ? `, built in ${builds.map((b) => `${b.build_s!.toFixed(1)}s`).join(", ")}` : " (existing index)"}`);
   console.log(`   index ${(Number(sizes.index) / 2 ** 20).toFixed(0)} MB, table ${(Number(sizes.heap) / 2 ** 20).toFixed(0)} MB`);
   console.log(`   ${"queries".padEnd(18)}${"exact precision".padEnd(17)}${EF.map((ef) => `ef ${ef}: recall / precision`.padEnd(34)).join("")}`);
   for (const g of groups) {
      const exactP = mean(g.idx.map((i) => base[i].exactPrecision));
      const cells = EF.map((ef) => {
         const r = builds.map((b) => mean(g.idx.map((i) => b.per[i][`ef${ef}`].recall)));
         const p = builds.map((b) => mean(g.idx.map((i) => b.per[i][`ef${ef}`].precision)));
         summary[`${g.kind}/ef${ef}`] = { recall: mean(r), recall_range: minMax(r), precision: mean(p), precision_range: minMax(p) };
         const range = (xs: number[]) => (builds.length > 1 ? ` (${minMax(xs).map((x) => (x * 100).toFixed(0)).join("–")})` : "");
         return `${pct(mean(r))}${range(r)} / ${pct(mean(p))}${range(p)}`.padEnd(34);
      });
      summary[`${g.kind}/exact`] = { precision: exactP };
      console.log(`   ${`${g.kind} (n=${g.idx.length})`.padEnd(18)}${pct(exactP).padEnd(17)}${cells.join("")}`);
   }
   const zero = (get: (i: number, b: number) => number) =>
      builds.map((_, b) => base.filter((_, i) => get(i, b) === 0).length);
   console.log(
      `   queries with no relevant result: exact ${zero((i) => base[i].exactPrecision)[0]}, ` +
         EF.map((ef) => {
            const [lo, hi] = minMax(zero((i, b) => builds[b].per[i][`ef${ef}`].precision));
            return `ef ${ef} ${lo === hi ? lo : `${lo}–${hi}`}`;
         }).join(", "),
   );

   // ---- 2. deep dive, on the last build ----
   const last = builds[builds.length - 1].per;
   const order = base.map((_, i) => i).sort((a, b) => last[a].ef160.recall - last[b].ef160.recall);
   // "The index failed" = relevant logs exist (exact finds them) and HNSW loses them:
   // the biggest precision drop from exact to HNSW. Low recall alone is not enough,
   // since exact search may have nothing relevant to lose (then the model failed).
   const loss = (i: number) => base[i].exactPrecision - last[i].ef160.precision;
   const worst = base.map((_, i) => i).sort((a, b) => loss(b) - loss(a) || last[a].ef160.recall - last[b].ef160.recall)[0];
   const candidates: [string, number | undefined][] = [
      [loss(worst) > 0 ? "biggest precision loss vs exact (the index failed)" : "worst HNSW recall (no precision lost)", worst],
      ["median HNSW recall", order[Math.floor(order.length / 2)]],
      ["paraphrase HNSW gets right", [...order].reverse().find((i) => base[i].kind === "paraphrase")],
      ["exact search fails too (the model failed)", base.findIndex((q) => q.exactPrecision === 0)],
   ];
   // skip missing picks and queries already picked
   const picks = candidates.flatMap(([why, i], n) =>
      i !== undefined && i >= 0 && candidates.findIndex(([, j]) => j === i) === n ? [{ why, i }] : [],
   );

   console.log(`\n2) deep dive: EXPLAIN (ANALYZE, BUFFERS), median of 5 runs`);
   const deep = [];
   for (const { why, i } of picks) {
      const q = base[i];
      const h = last[i].ef160;
      console.log(`\n"${q.text}" [${q.kind}, expected ${q.expected}]: ${why}`);
      console.log(`   nearest log at cosine distance ${q.exact[0].distance.toFixed(3)}`);
      const plans: Record<string, any> = {};
      for (const how of ["exact", ...EF] as const) {
         const runs = [];
         for (let r = 0; r < 5; r++) runs.push(await explain(q.vec, how));
         const p = { ...runs[runs.length - 1], ms: median(runs.map((r) => r.ms)) };
         plans[String(how)] = p;
         const label = how === "exact" ? "exact" : `hnsw ef ${how}`;
         console.log(
            `   ${label.padEnd(11)}${p.ms.toFixed(2).padStart(8)} ms   ` +
               `pages ${(p.pages.hit + p.pages.read).toLocaleString().padStart(7)} (hit ${p.pages.hit}, read ${p.pages.read})   ${p.plan}`,
         );
      }
      console.log(`   HNSW ef 160: recall ${pct(h.recall)}, precision ${pct(h.precision)} (exact: ${pct(q.exactPrecision)})`);
      const exactIds = new Set(q.exact.map((r) => r.id));
      const hnswIds = new Set(h.hits.map((r: Row) => r.id));
      const missed = q.exact.filter((r) => !hnswIds.has(r.id) && r.distance < h.hits[K - 1].distance - 1e-5);
      const instead = h.hits.filter((r: Row) => !exactIds.has(r.id) && r.distance > q.exact[K - 1].distance + 1e-5);
      const show = (r: Row) => `     d=${r.distance.toFixed(3)} ${r.root_cause.padEnd(22)} ${r.message.slice(0, 70)}`;
      if (missed.length) {
         console.log(`   exact found, HNSW missed (${missed.length}):`);
         missed.slice(0, 3).forEach((r) => console.log(show(r)));
         console.log(`   HNSW returned instead (${instead.length}):`);
         instead.slice(0, 3).forEach((r: Row) => console.log(show(r)));
      }
      if (q.exactPrecision === 0) {
         console.log("   exact search's top results (none relevant):");
         q.exact.slice(0, 3).forEach((r) => console.log(show(r)));
      }
      deep.push({
         text: q.text, kind: q.kind, expected: q.expected, why,
         nearest_distance: q.exact[0].distance, kth_distance: q.exact[K - 1].distance,
         exact_precision: q.exactPrecision, hnsw_ef160: { recall: h.recall, precision: h.precision },
         plans, missed, instead,
      });
   }

   const out = flag("out") ? path.resolve(ROOT, flag("out")!) : path.join(ROOT, `evals/results/hnsw-dive-${size}.json`);
   mkdirSync(path.dirname(out), { recursive: true });
   writeFileSync(
      out,
      JSON.stringify(
         {
            created_at: new Date().toISOString(),
            rows: info.rows,
            index: { m: M, ef_construction: EF_CONSTRUCTION, bytes: Number(sizes.index), builds_s: builds.map((b) => b.build_s) },
            k: K,
            summary,
            per_query: base.map((q, i) => ({
               text: q.text, kind: q.kind, expected: q.expected, exact_precision: q.exactPrecision,
               builds: builds.map((b) => Object.fromEntries(EF.map((ef) => [`ef${ef}`, { recall: b.per[i][`ef${ef}`].recall, precision: b.per[i][`ef${ef}`].precision }]))),
            })),
            deep_dive: deep,
         },
         null,
         2,
      ),
   );
   console.log(`\nwrote ${path.relative(ROOT, out)}`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
