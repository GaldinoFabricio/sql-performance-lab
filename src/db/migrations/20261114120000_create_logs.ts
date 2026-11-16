import type { Knex } from "knex";

// Dimension of all-MiniLM-L6-v2 (src/embeddings/embedder.ts). Hard-coded here
// because a migration is a frozen snapshot: switching models means a new
// migration and re-embedding every row.
const EMBEDDING_DIM = 384;

export async function up(knex: Knex): Promise<void> {
   await knex.raw("CREATE EXTENSION IF NOT EXISTS vector");

   await knex.schema.createTable("logs", (table) => {
      table.bigIncrements("id").primary();
      table
         .timestamp("created_at", { useTz: true })
         .notNullable()
         .defaultTo(knex.fn.now());
      table.text("service").notNullable();
      table.text("level").notNullable(); // INFO | WARN | ERROR | FATAL
      table.text("error_code"); // e.g. ECONNREFUSED, 23505, HTTP_502 (null for INFO)
      table.text("message").notNullable();
      // Seed-only label: which incident template generated the row.
      // Search never reads it; evals use it to judge "is this result about the
      // same problem?" beyond exact-vector ground truth.
      table.text("root_cause");
   });

   // Nullable on purpose: rows are inserted first and embedded later by
   // `pnpm embed:logs`, which resumes from the rows where this is NULL.
   await knex.raw(`ALTER TABLE logs ADD COLUMN embedding vector(${EMBEDDING_DIM})`);
}

export async function down(knex: Knex): Promise<void> {
   await knex.schema.dropTable("logs");
   // The extension is left installed: other objects may depend on it and
   // dropping it is not needed to undo this migration's table.
}
