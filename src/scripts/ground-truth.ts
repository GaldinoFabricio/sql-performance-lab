import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import db from "../db/knex";
import { MODEL_ID } from "../embeddings/model";
import {
   compareTopK,
   cosineDistance,
   DISTANCE_EPS,
   GROUND_TRUTH_VERSION,
   GroundTruth,
   GroundTruthQuery,
   rootCauseAgreement,
   sampleQueryIds,
   TopK,
} from "../evals/ground-truth";

/**
 * Builds evals/ground_truth.json: for N sampled logs, the exact top-k
 * nearest neighbors by cosine distance, found with a forced sequential scan.
 *
 * The answer is then recomputed in JS (float64, brute force) and the script
 * fails if the two disagree. See evals/README.md for why this is a valid
 * ground truth for measuring ANN (HNSW) recall later.
 *
 * Usage: pnpm eval:ground-truth [--queries=100] [--k=10] [--seed=42] [--out=evals/ground_truth.json]
 */

function arg(name: string, fallback: number): number {
   const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
   const value = hit ? Number(hit.split("=")[1]) : fallback;
   if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
   return value;
}

const QUERIES = arg("queries", 100);
const K = arg("k", 10);
const SEED = arg("seed", 42);
const OUT = path.resolve(
   process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length) ??
      path.join(__dirname, "../../evals/ground_truth.json"),
);
// Rows read per round trip in the JS cross-check (~0.6 KB of text each).
const STREAM_BATCH = 20_000;

const kthOf = (n: { distance: number }[]) => n[n.length - 1].distance;

interface QueryRow {
   id: string;
   level: string;
   root_cause: string | null;
   message: string;
   embedding: string;
}

/**
 * Brute force in JS over the whole table, streamed by primary key so memory
 * stays O(batch + queries * k) even at 1M rows.
 */
async function jsExactTopK(queries: Map<number, Float64Array>): Promise<Map<number, TopK>> {
   const tops = new Map([...queries.keys()].map((id) => [id, new TopK(K)]));
   const qs = [...queries].map(([id, v]) => ({ id, v, top: tops.get(id)! }));
   let cursor = 0;
   for (;;) {
      const { rows } = await db.raw(
         "SELECT id, embedding::text AS e FROM logs WHERE id > ? ORDER BY id LIMIT ?",
         [cursor, STREAM_BATCH],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
         const id = Number(r.id);
         const v = Float64Array.from(JSON.parse(r.e));
         for (const q of qs) if (q.id !== id) q.top.push({ id, distance: cosineDistance(q.v, v) });
      }
      cursor = Number(rows[rows.length - 1].id);
   }
   return tops;
}

async function main() {
   const { rows: [pending] } = await db.raw("SELECT count(*) AS n FROM logs WHERE embedding IS NULL");
   if (Number(pending.n) > 0) throw new Error(`${pending.n} logs have no embedding yet; run pnpm embed:logs`);

   // 1. Sample the query rows (ids only, then just those rows).
   const allIds: number[] = (await db.raw("SELECT id FROM logs")).rows.map((r: any) => Number(r.id));
   const queryIds = sampleQueryIds(allIds, QUERIES, SEED);
   const queryRows: QueryRow[] = (
      await db.raw("SELECT id, level, root_cause, message, embedding::text FROM logs WHERE id = ANY(?::bigint[])", [
         queryIds,
      ])
   ).rows;
   const byId = new Map(queryRows.map((r) => [Number(r.id), r]));
   console.log(`${allIds.length.toLocaleString("en-US")} rows, ${queryIds.length} sampled queries (seed ${SEED})`);

   // 2. Exact search in Postgres. Index scans are disabled so the planner
   // cannot pick an approximate index (HNSW/IVFFlat) once one exists, and the
   // plan is checked instead of trusted.
   const { sqlResults, seqScanMs, plan } = await db.transaction(async (trx) => {
      for (const s of ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"]) {
         await trx.raw(`SET LOCAL ${s} = off`);
      }
      const knn = `
         SELECT q.id AS query_id, n.id, n.distance, n.root_cause
         FROM logs q
         CROSS JOIN LATERAL (
            SELECT l.id, l.root_cause, l.embedding <=> q.embedding AS distance
            FROM logs l
            WHERE l.id <> q.id
            ORDER BY l.embedding <=> q.embedding, l.id
            LIMIT ?
         ) n
         WHERE q.id = ANY(?::bigint[])
         ORDER BY q.id, n.distance, n.id`;
      const explain = (await trx.raw(`EXPLAIN ${knn}`, [K, queryIds])).rows.map((r: any) => r["QUERY PLAN"]);
      const t = performance.now();
      const res = (await trx.raw(knn, [K, queryIds])).rows;
      return { sqlResults: res, seqScanMs: performance.now() - t, plan: explain as string[] };
   });
   if (!plan.some((l) => l.includes("Seq Scan on logs l")) || plan.some((l) => /Index.*on logs l/.test(l))) {
      throw new Error(`expected a sequential scan for the neighbors, got:\n${plan.join("\n")}`);
   }
   console.log(`exact search (seq scan): ${queryIds.length} queries in ${(seqScanMs / 1000).toFixed(2)}s`);

   const grouped = new Map<number, GroundTruthQuery["neighbors"]>();
   for (const r of sqlResults) {
      const list = grouped.get(Number(r.query_id)) ?? [];
      list.push({ id: Number(r.id), distance: Number(r.distance), root_cause: r.root_cause });
      grouped.set(Number(r.query_id), list);
   }

   // 3. Independent recomputation in JS. Any disagreement aborts the run.
   const t1 = performance.now();
   const jsTops = await jsExactTopK(
      new Map(queryIds.map((id) => [id, Float64Array.from(JSON.parse(byId.get(id)!.embedding))])),
   );
   for (const qid of queryIds) {
      const diff = compareTopK(grouped.get(qid) ?? [], jsTops.get(qid)!.result());
      if (diff) throw new Error(`query ${qid}: Postgres and JS disagree (${diff})`);
   }
   console.log(`cross-check: Postgres == JS float64 brute force for all ${queryIds.length} queries ` +
      `(${((performance.now() - t1) / 1000).toFixed(1)}s, eps=${DISTANCE_EPS})`);

   // 4. Ties on the k-th distance: rows outside the top-k that are just as close.
   const { rows: tieRows } = await db.raw(
      `SELECT v.qid AS query_id, count(*) AS tied
       FROM unnest(?::bigint[], ?::float8[]) AS v(qid, kth)
       JOIN logs q ON q.id = v.qid
       JOIN logs l ON l.id <> q.id AND (l.embedding <=> q.embedding) <= v.kth + ?
       GROUP BY v.qid`,
      [queryIds, queryIds.map((q) => kthOf(grouped.get(q)!)), DISTANCE_EPS],
   );
   const tied = new Map<number, number>(tieRows.map((r: any) => [Number(r.query_id), Number(r.tied)]));

   const { rows: [fp] } = await db.raw(
      "SELECT md5(string_agg(id || ':' || md5(embedding::text), ',' ORDER BY id)) AS fingerprint FROM logs",
   );

   const queries: GroundTruthQuery[] = queryIds.map((qid) => {
      const row = byId.get(qid)!;
      const neighbors = grouped.get(qid)!;
      return {
         id: qid,
         level: row.level,
         root_cause: row.root_cause,
         message: row.message,
         kth_distance: kthOf(neighbors),
         ties_beyond_k: Math.max(0, (tied.get(qid) ?? 0) - K),
         neighbors,
      };
   });

   const truth: GroundTruth = {
      version: GROUND_TRUTH_VERSION,
      created_at: new Date().toISOString(),
      model: MODEL_ID,
      metric: "cosine_distance",
      k: K,
      seed: SEED,
      rows: allIds.length,
      fingerprint: fp.fingerprint,
      self_excluded: true,
      queries,
   };
   mkdirSync(path.dirname(OUT), { recursive: true });
   writeFileSync(OUT, JSON.stringify(truth, null, 2) + "\n");

   // 5. Summary.
   const levels = new Map<string, number>();
   for (const q of queries) levels.set(q.level, (levels.get(q.level) ?? 0) + 1);
   const withTies = queries.filter((q) => q.ties_beyond_k > 0);
   const agree = queries.reduce((a, q) => a + rootCauseAgreement(q), 0) / queries.length;
   console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
   console.log(`  queries by level: ${[...levels].map(([l, n]) => `${l} ${n}`).join(", ")}`);
   console.log(`  ties at the k-th distance: ${withTies.length}/${queries.length} queries ` +
      `(max ${Math.max(0, ...withTies.map((q) => q.ties_beyond_k))} extra rows)`);
   console.log(`  neighbors with the query's root_cause: ${(agree * 100).toFixed(1)}%`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
