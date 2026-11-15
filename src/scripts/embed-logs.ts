import db from "../db/knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { MODEL_ID } from "../embeddings/model";

/**
 * Backfills logs.embedding for every row where it is still NULL.
 *
 * Resumable by construction: the checkpoint is the data itself. Each batch
 * is written in one UPDATE (atomic), so after a crash or Ctrl+C the next run
 * simply picks up the rows that are still NULL. No progress file to get out
 * of sync with the table.
 *
 * Usage: pnpm embed:logs [--batch=256] [--limit=N]
 */

function arg(name: string, fallback: number): number {
   const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
   const value = hit ? Number(hit.split("=")[1]) : fallback;
   if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
   return value;
}

const BATCH = arg("batch", 256);
const LIMIT = arg("limit", Number.MAX_SAFE_INTEGER);
const REPORT_EVERY_MS = 10_000;

let stopping = false;
process.on("SIGINT", () => {
   if (stopping) process.exit(130);
   stopping = true;
   console.log("\nSIGINT: finishing the current batch, then stopping (Ctrl+C again to abort)");
});

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const duration = (s: number) =>
   s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${(s / 60).toFixed(1)}min` : `${s.toFixed(0)}s`;

async function deadTuples(): Promise<{ live: number; dead: number; size: string }> {
   const { rows } = await db.raw(`
      SELECT n_live_tup AS live, n_dead_tup AS dead,
             pg_size_pretty(pg_total_relation_size('logs')) AS size
      FROM pg_stat_user_tables WHERE relname = 'logs'`);
   return { live: Number(rows[0].live), dead: Number(rows[0].dead), size: rows[0].size };
}

async function main() {
   const { rows: [counts] } = await db.raw(
      "SELECT count(*) FILTER (WHERE embedding IS NULL) AS pending, count(*) AS total FROM logs",
   );
   const pending = Number(counts.pending);
   const total = Number(counts.total);
   const target = Math.min(pending, LIMIT);
   console.log(
      `${MODEL_ID}: ${fmt(total - pending)}/${fmt(total)} already embedded, ` +
         `${fmt(target)} to go (batch=${BATCH})`,
   );
   if (target === 0) return finish(0, 0, 0, pending);

   const start = performance.now();
   let done = 0;
   let cursor = 0; // keyset pagination: id > cursor uses the primary key
   let embedMs = 0;
   let dbMs = 0;
   let lastReport = start;
   let lastDone = 0;

   while (done < target && !stopping) {
      let t = performance.now();
      const rows: { id: string; message: string }[] = (
         await db.raw(
            `SELECT id, message FROM logs
             WHERE embedding IS NULL AND id > ?
             ORDER BY id LIMIT ?`,
            [cursor, Math.min(BATCH, target - done)],
         )
      ).rows;
      if (rows.length === 0) break;

      // Exact duplicates ("Health check OK") are embedded once per batch.
      const unique = [...new Set(rows.map((r) => r.message))];
      dbMs += performance.now() - t;

      t = performance.now();
      const vectors = await embed(unique);
      const byText = new Map(unique.map((m, i) => [m, toPgVector(vectors[i])]));
      embedMs += performance.now() - t;

      t = performance.now();
      await db.raw(
         `UPDATE logs AS l SET embedding = v.embedding::vector
          FROM unnest(?::bigint[], ?::text[]) AS v(id, embedding)
          WHERE l.id = v.id`,
         [rows.map((r) => r.id), rows.map((r) => byText.get(r.message)!)],
      );
      dbMs += performance.now() - t;

      done += rows.length;
      cursor = Number(rows[rows.length - 1].id);

      const now = performance.now();
      if (now - lastReport >= REPORT_EVERY_MS) {
         const windowRate = ((done - lastDone) / (now - lastReport)) * 1000;
         const overall = (done / (now - start)) * 1000;
         console.log(
            `${fmt(done)}/${fmt(target)} (${((done / target) * 100).toFixed(1)}%) ` +
               `${fmt(windowRate)} rows/s now, ${fmt(overall)} avg, ` +
               `ETA ${duration((target - done) / overall)}`,
         );
         lastReport = now;
         lastDone = done;
      }
   }

   return finish(done, (performance.now() - start) / 1000, embedMs, pending - done, dbMs);
}

async function finish(done: number, secs: number, embedMs: number, remaining: number, dbMs = 0) {
   if (done > 0) {
      const share = (ms: number) => `${((ms / (embedMs + dbMs)) * 100).toFixed(0)}%`;
      console.log(
         `\nembedded ${fmt(done)} rows in ${duration(secs)}: ${fmt(done / secs)} rows/s ` +
            `(model ${share(embedMs)}, database ${share(dbMs)} of the time)`,
      );
   }
   if (remaining > 0) {
      console.log(`${fmt(remaining)} rows still pending; run again to resume.`);
   } else if (done > 0) {
      // Every UPDATE wrote a new version of the row (MVCC); the old one is a
      // dead tuple until VACUUM. Show it, then clean up and refresh stats.
      const before = await deadTuples();
      console.log(`before VACUUM: ${fmt(before.live)} live, ${fmt(before.dead)} dead tuples, ${before.size}`);
      await db.raw("VACUUM (ANALYZE) logs");
      const after = await deadTuples();
      console.log(`after  VACUUM: ${fmt(after.live)} live, ${fmt(after.dead)} dead tuples, ${after.size}`);
   }
   await db.destroy();
}

main().catch(async (err) => {
   console.error(err);
   await db.destroy();
   process.exit(1);
});
