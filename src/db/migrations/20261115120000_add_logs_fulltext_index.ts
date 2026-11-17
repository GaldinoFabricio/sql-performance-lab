import type { Knex } from "knex";

// Full-text baseline for the semantic search chapter: a GIN index over the
// message's English tsvector. An expression index (instead of a generated
// tsvector column) keeps the table narrow; queries must use the exact same
// expression, to_tsvector('english', message), or the planner won't match it.
//
// Not CONCURRENTLY: logs is a lab table seeded offline. Phase 5 covers
// CREATE INDEX CONCURRENTLY and its migration caveats.
export async function up(knex: Knex): Promise<void> {
   await knex.raw(
      "CREATE INDEX IF NOT EXISTS idx_logs_message_fts ON logs USING gin (to_tsvector('english', message))",
   );
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw("DROP INDEX IF EXISTS idx_logs_message_fts");
}
