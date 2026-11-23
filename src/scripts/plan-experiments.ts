import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Knex } from "knex";
import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { mean, percentile, recallAtK } from "../evals/metrics";

/**
 * Phase 5: query plans and classic indexing, on the same logs table.
 *
 * Each experiment saves its EXPLAIN (ANALYZE, BUFFERS) to
 * evals/plans/<id>.txt; the numbers go to evals/results/plans-<size>.json.
 * evals/plans/README.md explains the plans.
 *
 * "Before" states (no index, an extra index) are made inside a transaction
 * that is always rolled back: PostgreSQL DDL is transactional, so
 * DROP INDEX + EXPLAIN + ROLLBACK shows the plan without the index and puts
 * it back instantly, without a rebuild. The DROP holds an ACCESS EXCLUSIVE
 * lock until the rollback, so this is for a lab, not for production.
 *
 * Needs the migrations applied (idx_logs_service_created_at,
 * idx_logs_embedding_hnsw) and embedded logs. For pg_stat_statements the
 * server needs shared_preload_libraries = 'pg_stat_statements'.
 *
 * Usage: pnpm eval:plans [--only=composite,redundant,...]
 */

type Conn = Knex | Knex.Transaction;

const ROOT = path.resolve(__dirname, "../..");
const PLANS_DIR = path.join(ROOT, "evals/plans");
const COMPOSITE = "idx_logs_service_created_at";
const HNSW = "idx_logs_embedding_hnsw";
const GIN = "idx_logs_message_fts";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const enabled = (name: string) => !only || only.includes(name);

interface PlanRecord {
   id: string;
   title: string;
   sql: string;
   setup: string[];
   nodes: string[]; // plan node types, top-down
   indexes: string[]; // indexes the plan touches
   execution_ms: number; // from EXPLAIN ANALYZE (one run, with timing overhead)
   p50_ms: number; // wall time of the plain query, median of 5 warm runs
   rows: number;
   buffers: { hit: number; read: number }; // top node, 8 KB pages
}
/**
 * What an experiment's title claims about its plan. plan() throws when the
 * plan disagrees, so a title like "index ignored" can't be published next to
 * a plan that used the index.
 */
interface Expect {
   uses?: string; // this index appears in the plan
   avoids?: string; // this index does not appear
   node?: string; // some plan node's name contains this ("Seq Scan" also matches "Parallel Seq Scan")
}
const plans: PlanRecord[] = [];
const extra: Record<string, unknown> = {};

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** Runs fn in a transaction that is always rolled back. */
async function scratch<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
   const trx = await db.transaction();
   try {
      return await fn(trx);
   } finally {
      await trx.rollback();
   }
}

async function timeQuery(c: Conn, sql: string, bindings: readonly unknown[], runs = 5) {
   await c.raw(sql, bindings as any); // warm-up
   const times: number[] = [];
   let rows = 0;
   for (let i = 0; i < runs; i++) {
      const t = performance.now();
      const r = await c.raw(sql, bindings as any);
      times.push(performance.now() - t);
      rows = r.rows.length;
   }
   return { p50: percentile(times, 50), rows };
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) one query with whatever `setup` statements
 * apply (SET LOCAL, DROP INDEX...), save the plan, record a summary.
 */
async function plan(
   c: Conn,
   id: string,
   title: string,
   sql: string,
   bindings: readonly unknown[] = [],
   setup: string[] = [],
   expect: Expect = {},
): Promise<PlanRecord> {
   const timing = await timeQuery(c, sql, bindings);
   const { rows } = await c.raw(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, bindings as any);
   const lines: string[] = rows.map((r: any) => r["QUERY PLAN"]);
   const text = lines.join("\n").replace(/'\[[-\d.e,]+\]'/g, "'[…384 floats…]'");
   const nodes = lines
      .map((l) => /^\s*(?:->\s*)?([A-Z][A-Za-z ]+?)(?: using| on|  \(|$)/.exec(l)?.[1])
      .filter((n): n is string => !!n && !/^(Planning|Execution|Buffers|Sort Method|Workers)/.test(n));
   const indexes = [...new Set([...text.matchAll(/(?:using|on) (idx_\w+)/g)].map((m) => m[1]))];
   const top = /Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?/.exec(text);
   const shown = (c as any).client
      .raw(sql, bindings as any)
      .toQuery()
      .replace(/'\[[-\d.e,]+\]'/g, "'[…384 floats…]'");
   const record: PlanRecord = {
      id,
      title,
      sql: shown,
      setup,
      nodes,
      indexes,
      execution_ms: Number(/Execution Time: ([\d.]+)/.exec(text)?.[1]),
      p50_ms: round(timing.p50),
      rows: timing.rows,
      buffers: { hit: Number(top?.[1] ?? 0), read: Number(top?.[2] ?? 0) },
   };
   const wrong = [
      expect.uses && !indexes.includes(expect.uses) && `expected index ${expect.uses}`,
      expect.avoids && indexes.includes(expect.avoids) && `expected the plan to avoid ${expect.avoids}`,
      expect.node && !nodes.some((n) => n.includes(expect.node!)) && `expected a ${expect.node} node`,
   ].filter(Boolean);
   if (wrong.length) {
      throw new Error(`${id} ("${title}"): ${wrong.join("; ")}, got ${nodes.join(" > ")} using [${indexes.join(", ")}]`);
   }
   plans.push(record);
   writeFileSync(
      path.join(PLANS_DIR, `${id}.txt`),
      [`-- ${title}`, ...setup.map((s) => `-- setup: ${s}`), "", shown + ";", "", text, ""].join("\n"),
   );
   console.log(
      `  ${id.padEnd(34)} ${nodes.slice(0, 3).join(" > ").padEnd(46)} p50 ${record.p50_ms.toFixed(2).padStart(8)} ms  rows ${record.rows}`,
   );
   return record;
}

async function run(c: Conn, sqls: string[]) {
   for (const s of sqls) await c.raw(s);
}

async function requireIndex(name: string) {
   const { rows } = await db.raw("SELECT 1 FROM pg_indexes WHERE indexname = ?", [name]);
   if (!rows.length) throw new Error(`${name} is missing; run pnpm migrate`);
}

// ------------------------------------------------------------ experiments --

async function composite(refTs: string) {
   console.log("\ncomposite index (service, created_at DESC), leftmost prefix");
   const latest = `SELECT id, created_at, level, message FROM logs WHERE service = ? ORDER BY created_at DESC LIMIT 50`;
   await scratch(async (trx) => {
      const setup = [`DROP INDEX ${COMPOSITE}`];
      await run(trx, setup);
      await plan(trx, "01-latest-by-service-no-index", "Latest 50 logs of a service, without the composite index", latest, ["payments"], setup, { avoids: COMPOSITE, node: "Seq Scan" });
   });
   await plan(db, "02-latest-by-service-composite", "Latest 50 logs of a service, with (service, created_at DESC)", latest, ["payments"], [], { uses: COMPOSITE });
   await plan(
      db,
      "03-prefix-service-and-time",
      "Leftmost prefix: service = and a time range use both columns",
      `SELECT id, created_at, level FROM logs WHERE service = ? AND created_at >= ?::timestamptz - interval '1 hour' ORDER BY created_at DESC`,
      ["payments", refTs],
      [],
      { uses: COMPOSITE },
   );
   await plan(
      db,
      "04-prefix-time-only",
      "Leftmost prefix: created_at alone can't seek into (service, created_at)",
      `SELECT id, created_at, level FROM logs WHERE created_at >= ?::timestamptz - interval '1 hour' ORDER BY created_at DESC`,
      [refTs],
      [],
      { uses: COMPOSITE },
   );
   await plan(
      db,
      "05-prefix-service-only",
      "Leftmost prefix: service alone uses the index (first column)",
      `SELECT count(*) FROM logs WHERE service = ?`,
      ["shipping"],
      [],
      { uses: COMPOSITE },
   );
}

/**
 * A single-column (service) index next to (service, created_at DESC) is
 * redundant: every query it serves, the composite serves by its prefix.
 * It still costs disk and a little work on every INSERT.
 */
async function redundant() {
   console.log("\nredundant index (service) and INSERT throughput");
   // Copying existing rows (embedding included) keeps the comparison about
   // index maintenance: the read side is the same in every variant. HNSW
   // inserts are ~100x slower, so that variant copies fewer rows.
   const insert = (n: number) => `INSERT INTO logs (created_at, service, level, error_code, message, root_cause, embedding)
                   SELECT created_at, service, level, error_code, message, root_cause, embedding
                   FROM logs ORDER BY id LIMIT ${n}`;
   const others = [GIN, HNSW];
   const variants: { name: string; setup: string[]; rows: number; repeats: number }[] = [
      { name: "primary key only", setup: [`DROP INDEX ${COMPOSITE}`, ...others.map((i) => `DROP INDEX ${i}`)], rows: 50_000, repeats: 7 },
      { name: "+ (service, created_at)", setup: others.map((i) => `DROP INDEX ${i}`), rows: 50_000, repeats: 7 },
      { name: "+ (service, created_at) + (service)", setup: [...others.map((i) => `DROP INDEX ${i}`), "CREATE INDEX idx_logs_service ON logs (service)"], rows: 50_000, repeats: 7 },
      { name: "+ GIN full-text", setup: [`DROP INDEX ${HNSW}`], rows: 50_000, repeats: 7 },
      { name: "+ GIN full-text + HNSW (all production indexes)", setup: [], rows: 5_000, repeats: 3 },
   ];
   // Rounds interleave the variants, so drift (table growth from the
   // rolled-back rows, background work) spreads over all of them.
   const times = variants.map(() => [] as number[]);
   // WAL bytes written per inserted row: deterministic, unlike time, and it
   // counts every index page each INSERT touches.
   const wal = variants.map(() => [] as number[]);
   for (let round = 0; round < Math.max(...variants.map((v) => v.repeats)); round++) {
      for (const [i, v] of variants.entries()) {
         if (round >= v.repeats) continue;
         await scratch(async (trx) => {
            await run(trx, v.setup);
            const { rows: [a] } = await trx.raw("SELECT pg_current_wal_insert_lsn() AS lsn");
            const t = performance.now();
            await trx.raw(insert(v.rows));
            times[i].push(performance.now() - t);
            const { rows: [b] } = await trx.raw("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ?) AS bytes", [a.lsn]);
            wal[i].push(Number(b.bytes) / v.rows);
         });
      }
   }
   const results = variants.map((v, i) => {
      const rate = (ms: number) => Math.round((v.rows / ms) * 1000);
      const r = {
         variant: v.name,
         rows: v.rows,
         repeats: v.repeats,
         rows_per_s: rate(percentile(times[i], 50)),
         rows_per_s_range: [rate(Math.max(...times[i])), rate(Math.min(...times[i]))],
         wal_bytes_per_row: Math.round(percentile(wal[i], 50)),
      };
      console.log(`  ${v.name.padEnd(50)} ${r.rows_per_s.toLocaleString("en-US").padStart(8)} rows/s  (${r.rows_per_s_range.map((x) => x.toLocaleString("en-US")).join("–")})  WAL ${r.wal_bytes_per_row} B/row`);
      return r;
   });
   extra.insert_throughput = results;

   await scratch(async (trx) => {
      const setup = ["CREATE INDEX idx_logs_service ON logs (service)", "ANALYZE logs"];
      await run(trx, setup);
      const { rows } = await trx.raw(
         `SELECT relname, pg_relation_size(oid) AS bytes FROM pg_class WHERE relname IN (?, 'idx_logs_service')`,
         [COMPOSITE],
      );
      extra.redundant_sizes = Object.fromEntries(rows.map((r: any) => [r.relname, Number(r.bytes)]));
      await plan(trx, "06-redundant-service-index", "With both (service) and (service, created_at): the planner picks one", `SELECT count(*) FROM logs WHERE service = ?`, ["shipping"], setup);
   });
   // The rolled-back inserts leave dead tuples (and dead index entries).
   await db.raw("VACUUM (ANALYZE) logs");
}

/**
 * Same query, same index, 500 rows vs the full table. What decides between
 * reading the table and using the index is the share of rows a filter keeps
 * and how many pages the table has, not the row count alone.
 */
async function smallTable() {
   console.log("\n500 rows vs the full table");
   await db.raw("DROP TABLE IF EXISTS logs_500");
   await db.raw("CREATE TABLE logs_500 AS SELECT id, created_at, service, level, error_code, message FROM logs ORDER BY id LIMIT 500");
   await db.raw("CREATE INDEX idx_logs_500_service_created_at ON logs_500 (service, created_at DESC)");
   await db.raw("ANALYZE logs_500");
   try {
      const q = (t: string) => `SELECT id, created_at, level FROM ${t} WHERE service = ?`;
      const { rows: [s] } = await db.raw("SELECT pg_relation_size('logs_500') / 8192 AS pages, pg_relation_size('logs') / 8192 AS full_pages");
      extra.table_pages = { logs_500: Number(s.pages), logs: Number(s.full_pages) };
      const noIndex = ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_bitmapscan = off", "SET LOCAL enable_indexonlyscan = off"];
      for (const [t, label, n] of [["logs_500", "500 rows", "07"], ["logs", "full table", "10"]] as const) {
         const tag = t === "logs" ? "full" : "500";
         await plan(db, `${n}-${tag}-common-service`, `${label}, service = 'api-gateway' (36% of rows)`, q(t), ["api-gateway"], [], { node: "Seq Scan" });
         await plan(db, `${String(Number(n) + 1).padStart(2, "0")}-${tag}-rare-service`, `${label}, service = 'shipping' (~4% of rows)`, q(t), ["shipping"]);
         await scratch(async (trx) => {
            await run(trx, noIndex);
            await plan(trx, `${String(Number(n) + 2).padStart(2, "0")}-${tag}-rare-service-no-index`, `${label}, service = 'shipping', index scans disabled`, q(t), ["shipping"], noIndex, {
               avoids: t === "logs" ? COMPOSITE : "idx_logs_500_service_created_at",
               node: "Seq Scan",
            });
         });
      }
   } finally {
      await db.raw("DROP TABLE IF EXISTS logs_500");
   }
}

/** An index on a column where one value is most of the table. */
async function lowSelectivity() {
   console.log("\nlow selectivity: index on level");
   const { rows } = await db.raw("SELECT level, count(*)::int AS n FROM logs GROUP BY level ORDER BY n DESC");
   extra.level_distribution = rows;
   await scratch(async (trx) => {
      const setup = ["CREATE INDEX idx_logs_level ON logs (level)", "ANALYZE logs"];
      await run(trx, setup);
      const q = `SELECT id, service FROM logs WHERE level = ?`;
      await plan(trx, "13-level-info-74pct", "level = 'INFO' (most rows): index ignored", q, ["INFO"], setup, { avoids: "idx_logs_level", node: "Seq Scan" });
      await plan(trx, "14-level-fatal-1pct", "level = 'FATAL' (few rows): index used", q, ["FATAL"], setup, { uses: "idx_logs_level" });
      await run(trx, ["SET LOCAL enable_seqscan = off"]);
      await plan(trx, "15-level-info-forced-index", "level = 'INFO' with the index forced", q, ["INFO"], [...setup, "SET LOCAL enable_seqscan = off"], { uses: "idx_logs_level" });
   });
}

/**
 * WHERE + ORDER BY embedding with HNSW: the index returns its ef_search
 * nearest candidates first and the WHERE runs after, so a rare filter value
 * leaves fewer than k rows.
 */
async function filteredVector() {
   console.log("\nfilter + vector (HNSW + WHERE)");
   const k = 10;
   const service = "shipping";
   const { rows: [share] } = await db.raw("SELECT avg((service = ?)::int)::float AS s FROM logs", [service]);
   extra.filtered_service = { service, share: round(Number(share.s), 4) };
   const texts: string[] = JSON.parse(readFileSync(path.join(ROOT, "evals/text_queries.json"), "utf8")).queries.map(
      (q: any) => q.text,
   );
   const vecs = (await embed(texts)).map(toPgVector);
   const sql = `SELECT id, embedding <=> ?::vector AS distance FROM logs WHERE service = ? ORDER BY embedding <=> ?::vector LIMIT ${k}`;
   const b = (v: string) => [v, service, v];

   // Exact answer per query: no index scans, so a filtered full scan + sort.
   const truth: { kth: number }[] = [];
   await scratch(async (trx) => {
      await run(trx, ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_bitmapscan = off"]);
      for (const v of vecs) {
         const { rows } = await trx.raw(sql, b(v));
         truth.push({ kth: Number(rows[rows.length - 1].distance) });
      }
   });

   const variants: { id: string; title: string; setup: string[]; expect: Expect }[] = [
      { id: "16-filter-vector-ef40", title: "HNSW + WHERE service, ef_search = 40", setup: ["SET LOCAL hnsw.ef_search = 40", "SET LOCAL hnsw.iterative_scan = off"], expect: { uses: HNSW } },
      { id: "17-filter-vector-ef400", title: "Mitigation: larger ef_search (400)", setup: ["SET LOCAL hnsw.ef_search = 400", "SET LOCAL hnsw.iterative_scan = off"], expect: { uses: HNSW } },
      { id: "18-filter-vector-iterative", title: "Mitigation: iterative scan (pgvector 0.8, relaxed order)", setup: ["SET LOCAL hnsw.ef_search = 40", "SET LOCAL hnsw.iterative_scan = relaxed_order"], expect: { uses: HNSW } },
      {
         id: "19-filter-vector-partial-index",
         title: "Mitigation: partial HNSW index WHERE service = 'shipping'",
         setup: [
            "SET LOCAL maintenance_work_mem = '512MB'",
            `CREATE INDEX idx_logs_embedding_hnsw_shipping ON logs USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64) WHERE service = '${service}'`,
            "SET LOCAL hnsw.ef_search = 40",
            "SET LOCAL hnsw.iterative_scan = off",
         ],
         expect: { uses: "idx_logs_embedding_hnsw_shipping" },
      },
      { id: "20-filter-vector-btree-exact", title: "Mitigation: no HNSW, the B-tree finds the service and distances are sorted exactly", setup: [`DROP INDEX ${HNSW}`], expect: { avoids: HNSW } },
   ];
   const summary: Record<string, unknown>[] = [];
   for (const v of variants) {
      await scratch(async (trx) => {
         const t = performance.now();
         await run(trx, v.setup);
         const setupMs = performance.now() - t;
         const p = await plan(trx, v.id, v.title, sql, b(vecs[0]), v.setup, v.expect);
         const returned: number[] = [];
         const recall: number[] = [];
         const times: number[] = [];
         for (const [i, vec] of vecs.entries()) {
            const t0 = performance.now();
            const { rows } = await trx.raw(sql, b(vec));
            times.push(performance.now() - t0);
            returned.push(rows.length);
            recall.push(
               recallAtK(rows.map((r: any) => ({ id: Number(r.id), distance: Number(r.distance) })), { id: -1, kth_distance: truth[i].kth }, k),
            );
         }
         summary.push({
            id: v.id,
            title: v.title,
            indexes: p.indexes,
            avg_rows: round(mean(returned), 2),
            queries_under_k: returned.filter((n) => n < k).length,
            recall_at_k: round(mean(recall), 4),
            p50_ms: round(percentile(times, 50)),
            p95_ms: round(percentile(times, 95)),
            setup_ms: v.id.includes("partial") ? Math.round(setupMs) : undefined,
         });
         const s = summary[summary.length - 1] as any;
         console.log(`    ${texts.length} queries: avg rows ${s.avg_rows}, under k ${s.queries_under_k}, recall ${(s.recall_at_k * 100).toFixed(1)}%, p50 ${s.p50_ms} ms`);
      });
   }
   extra.filtered_vector = { k, queries: texts.length, variants: summary };
}

/** Which statements cost the most: in total, and per call. */
async function statStatements(refTs: string) {
   console.log("\npg_stat_statements");
   try {
      await db.raw("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
      await db.raw("SELECT pg_stat_statements_reset()");
   } catch (err) {
      console.log(`  skipped: ${(err as Error).message} (needs shared_preload_libraries = 'pg_stat_statements')`);
      return;
   }
   const services = ["api-gateway", "checkout", "payments", "auth", "orders", "shipping"];
   const { rows: idRows } = await db.raw("SELECT min(id)::int AS lo, max(id)::int AS hi FROM logs");
   const { lo, hi } = idRows[0];
   // A small, fixed workload with the shape of a real one: a dashboard
   // polling recent errors very often, point lookups, and a few heavy ad hoc
   // queries. The numbers depend on this mix; the lesson is the two rankings.
   for (let i = 0; i < 3000; i++) {
      await db.raw("SELECT id, message FROM logs WHERE id = ?", [lo + ((i * 7919) % (hi - lo))]);
   }
   for (let i = 0; i < 1500; i++) {
      await db.raw(
         "SELECT id, created_at, message FROM logs WHERE service = ? AND level = 'ERROR' ORDER BY created_at DESC LIMIT 20",
         [services[i % services.length]],
      );
   }
   // An alert check polled every few seconds: errors in the last 15
   // minutes. created_at is the index's second column, so this reads the
   // whole index each time (experiment 04).
   for (let i = 0; i < 300; i++) {
      await db.raw(
         "SELECT count(*) FROM logs WHERE level IN ('ERROR', 'FATAL') AND created_at >= ?::timestamptz - interval '15 minutes'",
         [refTs],
      );
   }
   for (let i = 0; i < 3; i++) {
      await db.raw("SELECT id, message FROM logs WHERE message ILIKE ? LIMIT 20", [["%deadline exceeded%", "%quota%", "%panic%"][i]]);
   }
   for (let i = 0; i < 3; i++) {
      await db.raw(
         "SELECT service, level, count(*) FROM logs WHERE created_at >= ?::timestamptz - (? || ' days')::interval GROUP BY service, level",
         [refTs, String(i + 1)],
      );
   }
   const cols = `left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS query, calls,
                 round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms,
                 round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct_total`;
   const filter = `WHERE query ILIKE '%FROM logs%' AND query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE 'EXPLAIN%'`;
   const { rows: byTotal } = await db.raw(`SELECT ${cols} FROM pg_stat_statements ${filter} ORDER BY total_exec_time DESC LIMIT 5`);
   const { rows: byMean } = await db.raw(`SELECT ${cols} FROM pg_stat_statements ${filter} ORDER BY mean_exec_time DESC LIMIT 5`);
   const fmt = (rs: any[]) =>
      rs.map((r) => `${String(r.calls).padStart(6)}  ${String(r.total_ms).padStart(10)}  ${String(r.mean_ms).padStart(10)}  ${String(r.pct_total).padStart(5)}%  ${r.query}`);
   const head = " calls    total ms     mean ms  %total  query";
   const text = ["-- top 5 by total_exec_time", head, ...fmt(byTotal), "", "-- top 5 by mean_exec_time", head, ...fmt(byMean), ""].join("\n");
   writeFileSync(path.join(PLANS_DIR, "21-pg-stat-statements.txt"), text);
   console.log(text.replace(/^/gm, "  "));
   extra.pg_stat_statements = { by_total: byTotal, by_mean: byMean };
}

// ------------------------------------------------------------------ main --

async function main() {
   await requireIndex(COMPOSITE);
   if (enabled("redundant") || enabled("vector")) await requireIndex(HNSW);
   mkdirSync(PLANS_DIR, { recursive: true });
   const { rows: [t] } = await db.raw("SELECT count(*)::int AS rows, max(created_at) AS ts FROM logs");
   const refTs = new Date(t.ts).toISOString();
   console.log(`${t.rows.toLocaleString("en-US")} rows, newest log at ${refTs}`);
   await db.raw("ANALYZE logs");

   const experiments: [string, () => Promise<void>][] = [
      ["composite", () => composite(refTs)],
      ["redundant", redundant],
      ["small", smallTable],
      ["selectivity", lowSelectivity],
      ["vector", filteredVector],
      ["stats", () => statStatements(refTs)],
   ];
   // When each experiment last ran: with --only the file mixes runs, so a
   // single top-level timestamp would date old results as new.
   const ranAt: Record<string, string> = {};
   for (const [name, fn] of experiments) {
      if (!enabled(name)) continue;
      await fn();
      ranAt[name] = new Date().toISOString();
   }

   const size = t.rows >= 1_000_000 ? `${t.rows / 1_000_000}m` : `${t.rows / 1000}k`;
   const out = path.join(ROOT, `evals/results/plans-${size}.json`);
   // With --only, keep the other experiments' results from the previous run;
   // `ran_at` says when each experiment last ran, `created_at` is the last write.
   const prev = only && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
   const ids = new Set(plans.map((p) => p.id));
   const merged = [...(prev.plans ?? []).filter((p: PlanRecord) => !ids.has(p.id)), ...plans].sort((a, b) =>
      a.id.localeCompare(b.id),
   );
   writeFileSync(
      out,
      JSON.stringify(
         { ...prev, created_at: new Date().toISOString(), rows: t.rows, ran_at: { ...prev.ran_at, ...ranAt }, plans: merged, ...extra },
         null,
         2,
      ) + "\n",
   );
   console.log(`\nwrote ${path.relative(ROOT, out)} and evals/plans/*.txt`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
