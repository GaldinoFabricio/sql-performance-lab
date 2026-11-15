import { Knex } from "knex";

// "Latest logs of a service": WHERE service = ? ORDER BY created_at DESC.
// With (service, created_at DESC) the planner walks the index already in the
// requested order and stops after LIMIT rows: no Sort node, no full scan.
//
// CREATE INDEX CONCURRENTLY builds without blocking writes (a plain CREATE
// INDEX holds a lock that stops every INSERT into logs until it ends). The
// price:
//  - it cannot run inside a transaction, so this migration opts out of
//    knex's per-migration transaction (`config` below);
//  - it scans the table twice and waits for running transactions, so it is
//    slower than a plain build;
//  - if it fails halfway it leaves an INVALID index behind. The planner
//    ignores it but every INSERT still maintains it, and IF NOT EXISTS would
//    happily skip over it. So a leftover invalid index is dropped first.
export const config = { transaction: false };

const INDEX = "idx_logs_service_created_at";

export async function up(knex: Knex): Promise<void> {
   const { rows } = await knex.raw(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?`,
      [INDEX],
   );
   if (rows.length && !rows[0].indisvalid) {
      await knex.raw(`DROP INDEX CONCURRENTLY ${INDEX}`);
   }
   await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON logs (service, created_at DESC)`);
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
}
