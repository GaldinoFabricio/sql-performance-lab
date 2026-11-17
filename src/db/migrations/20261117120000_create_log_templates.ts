import type { Knex } from "knex";

// Same model and dimension as logs.embedding (see 20261114120000_create_logs.ts).
const EMBEDDING_DIM = 384;

/**
 * One embedding per log template (Phase 1 of fixing search failures).
 * Filled by `pnpm templates:build` (src/search/templates.ts); all three
 * tables are derived data and can be rebuilt from `logs` at any time.
 *
 * Which template a log belongs to lives in a side table, not in a
 * logs.template_id column. Filling a column on existing rows is an UPDATE of
 * every row, and a non-HOT UPDATE writes a new entry in every index of the
 * table, including HNSW, where each insert costs ~200x a B-tree one (Phase 4).
 * At 1M rows that is tens of minutes to store one integer per log. A system
 * that templates logs on ingestion would set it in the INSERT instead.
 */
export async function up(knex: Knex): Promise<void> {
   await knex.schema.createTable("log_templates", (t) => {
      t.integer("id").primary(); // TemplateMiner cluster id, stable while the text generalizes
      t.text("partition").notNullable(); // "<level>|<error_code>": only these merge
      t.text("template").notNullable(); // with <*>, <num>, <id>... placeholders
      t.text("embed_text").notNullable(); // template with category values put back (src/logs/values.ts)
      t.text("embedded_text"); // the embed_text the current embedding was made from; differs = stale
      t.integer("log_count").notNullable();
      t.bigInteger("last_log_id").notNullable();
      t.text("example").notNullable(); // the newest raw message, for display
      t.jsonb("wildcards").notNullable().defaultTo("[]"); // values per <*>
   });
   await knex.raw(`ALTER TABLE log_templates ADD COLUMN embedding vector(${EMBEDDING_DIM})`);

   // Each normalized message (toTemplate output) seen so far and its template:
   // the miner's state, so new logs can be assigned without re-mining.
   await knex.schema.createTable("log_template_variants", (t) => {
      t.text("partition").notNullable();
      t.text("variant").notNullable();
      t.integer("template_id").notNullable().references("id").inTable("log_templates").onDelete("CASCADE");
      t.integer("log_count").notNullable();
      t.primary(["partition", "variant"]);
   });

   await knex.schema.createTable("log_template_map", (t) => {
      t.bigInteger("log_id").primary().references("id").inTable("logs").onDelete("CASCADE");
      t.integer("template_id").notNullable().references("id").inTable("log_templates").onDelete("CASCADE");
   });
   // "the newest logs of these templates": ids grow with created_at (append-only)
   await knex.raw("CREATE INDEX idx_log_template_map_template ON log_template_map (template_id, log_id DESC)");
}

export async function down(knex: Knex): Promise<void> {
   await knex.schema.dropTable("log_template_map");
   await knex.schema.dropTable("log_template_variants");
   await knex.schema.dropTable("log_templates");
}
