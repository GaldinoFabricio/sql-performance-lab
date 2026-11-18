import type { Knex } from "knex";

// Replaces the full HNSW index with a partial one that leaves INFO logs out.
//
// Measured with pnpm eval:partial-hnsw (evals/results/partial-hnsw-*.json),
// same m = 32 / ef_construction = 200, on the 60 typed queries:
//  - every typed query is about an incident (WARN, ERROR or FATAL), and INFO
//    is ~74% of the rows: the partial index holds a quarter of them;
//  - 100k rows, ef_search 160: precision@10 87.8% (87–88 over 3 builds)
//    against 80.1% (76–83) for the full index, at the same latency (~1.5 ms);
//    queries with no relevant log 7–8 against 10–14;
//  - 40 MB and 4.6 s to build, against 149 MB and 18.6 s;
//  - an INFO INSERT no longer touches HNSW: 2.2 KB of WAL and ~55k rows/s,
//    against 5.1 KB and ~1k rows/s with the full index.
// The price: only a query with exactly `WHERE level <> 'INFO'` can use it
// (NOT_INFO in src/search/search.ts), so INFO logs are searched without an
// index. GET /search/logs leaves INFO out unless include_info=true.
//
// Not CONCURRENTLY, as in 20261115130000: knex runs migrations in a
// transaction, and SET LOCAL sizes maintenance_work_mem for this build only.
const M = 32;
const EF_CONSTRUCTION = 200;
const FULL = "idx_logs_embedding_hnsw";
const PARTIAL = "idx_logs_embedding_hnsw_not_info";

// ~4 KB per indexed row keeps the graph in memory (see 20261115130000).
async function sizeMemory(knex: Knex, where: string) {
   const { rows } = await knex.raw(`SELECT count(*)::bigint AS n FROM logs ${where}`);
   const mb = Math.min(4096, Math.max(64, Math.ceil((Number(rows[0].n) * 4) / 1024)));
   await knex.raw(`SET LOCAL maintenance_work_mem = '${mb}MB'`);
}

export async function up(knex: Knex): Promise<void> {
   await knex.raw(`DROP INDEX IF EXISTS ${FULL}`);
   await sizeMemory(knex, "WHERE level <> 'INFO'");
   await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${PARTIAL} ON logs
       USING hnsw (embedding vector_cosine_ops) WITH (m = ${M}, ef_construction = ${EF_CONSTRUCTION})
       WHERE level <> 'INFO'`,
   );
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw(`DROP INDEX IF EXISTS ${PARTIAL}`);
   await sizeMemory(knex, "");
   await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${FULL} ON logs
       USING hnsw (embedding vector_cosine_ops) WITH (m = ${M}, ef_construction = ${EF_CONSTRUCTION})`,
   );
}
