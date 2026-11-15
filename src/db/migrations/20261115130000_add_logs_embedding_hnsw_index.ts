import { Knex } from "knex";

// HNSW index for vector search (GET /search/logs, modes vector and hybrid).
// Parameters chosen from the experiments in SEMANTIC_SEARCH.md:
//  - m = 32, ef_construction = 200 had the best free-text recall at every
//    size measured (10k, 100k, 1M); pgvector's default (16, 64) lost 12 to
//    23 points at ef_search 40;
//  - the price is build time: ~2 s at 10k, ~21 s at 100k, ~78 min at 1M on
//    4 vCPU (the default builds 1M in 4 to 10 min).
// The query-time knob, hnsw.ef_search, is set per request by the service.
//
// Not CONCURRENTLY: knex runs this migration in a transaction, which lets
// SET LOCAL size maintenance_work_mem for this build only. Phase 5
// (idx_logs_service_created_at) shows the CONCURRENTLY variant.
const M = 32;
const EF_CONSTRUCTION = 200;

export async function up(knex: Knex): Promise<void> {
   // The graph must fit in maintenance_work_mem or the build slows down a
   // lot; an oversized value slows parallel builds too (shared memory is
   // allocated up front). ~4 KB per row covers the graph with margin.
   const { rows } = await knex.raw("SELECT count(*)::bigint AS n FROM logs");
   const mb = Math.min(4096, Math.max(64, Math.ceil((Number(rows[0].n) * 4) / 1024)));
   await knex.raw(`SET LOCAL maintenance_work_mem = '${mb}MB'`);
   await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_logs_embedding_hnsw ON logs
       USING hnsw (embedding vector_cosine_ops) WITH (m = ${M}, ef_construction = ${EF_CONSTRUCTION})`,
   );
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw("DROP INDEX IF EXISTS idx_logs_embedding_hnsw");
}
