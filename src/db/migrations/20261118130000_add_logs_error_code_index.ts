import type { Knex } from "knex";

// B-tree on (error_code, id DESC) for the code list of hybrid search
// (src/search/codes.ts, Phase 3):
//  - "the newest logs with code X" is one index range read, already in
//    order: WHERE error_code = X ORDER BY id DESC LIMIT n;
//  - knownCodes() lists the distinct codes with a skip scan, one probe per code.
// Partial: INFO logs and some WARN have no code, and a search never looks
// for NULL. CONCURRENTLY, so building it on a large table does not block
// inserts; as in 20261116120000, an INVALID index left by a failed build is
// dropped first, since IF NOT EXISTS would skip over it.
export const config = { transaction: false };

const INDEX = "idx_logs_error_code";

export async function up(knex: Knex): Promise<void> {
   const { rows } = await knex.raw(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?`,
      [INDEX],
   );
   if (rows.length && !rows[0].indisvalid) await knex.raw(`DROP INDEX CONCURRENTLY ${INDEX}`);
   await knex.raw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON logs (error_code, id DESC)
       WHERE error_code IS NOT NULL`,
   );
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
}
