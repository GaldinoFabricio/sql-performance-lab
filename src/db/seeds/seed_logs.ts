import type { Knex } from "knex";
import { DEFAULT_SEED, generateLogs } from "../../logs/generator";

// How many logs to create. Default is small so `pnpm seed:run` stays fast
// (and CI cheap); experiments override it, e.g. LOGS_COUNT=1000000.
const DEFAULT_COUNT = 10_000;
// 6 columns x 5,000 rows = 30k bind params, below Postgres' 65,535 limit.
const CHUNK = 5_000;

export async function seed(knex: Knex): Promise<void> {
   const count = Number(process.env.LOGS_COUNT ?? DEFAULT_COUNT);
   const seedValue = Number(process.env.LOGS_SEED ?? DEFAULT_SEED);
   if (!Number.isInteger(count) || count < 0) {
      throw new Error(`LOGS_COUNT must be a non-negative integer, got ${process.env.LOGS_COUNT}`);
   }

   const start = performance.now();
   // RESTART IDENTITY: the same seed must produce the same ids, or the
   // golden dataset (which stores ids) would point at different rows.
   await knex.raw("TRUNCATE logs RESTART IDENTITY");

   let batch = [];
   for (const log of generateLogs({ count, seed: seedValue })) {
      batch.push(log);
      if (batch.length === CHUNK) {
         await knex("logs").insert(batch);
         batch = [];
      }
   }
   if (batch.length) await knex("logs").insert(batch);

   // Fresh statistics so the planner knows the real table size right away.
   await knex.raw("ANALYZE logs");

   const secs = (performance.now() - start) / 1000;
   console.log(
      `seed_logs: ${count.toLocaleString("en-US")} logs (seed=${seedValue}) in ${secs.toFixed(1)}s ` +
         `(${Math.round(count / Math.max(secs, 0.001)).toLocaleString("en-US")} rows/s)`,
   );
}
