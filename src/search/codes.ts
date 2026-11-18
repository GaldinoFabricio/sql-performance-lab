import type { Knex } from "knex";

/**
 * Error codes in a typed query (Phase 3, option A).
 *
 * logs.error_code holds codes such as ECONNRESET, 40P01 or HTTP_502. Many
 * never appear in the message text (every Postgres SQLSTATE, EDQUOT, NPE),
 * so full-text and vectors, which read only `message`, can't find them:
 * pnpm eval:codes measured 0% precision for those in every mode. Hybrid
 * search adds a third RRF list with the logs that carry a code found in the
 * query.
 *
 * A token is a code when it equals a known error_code, case-insensitively:
 * people type `econnreset` or "seeing ECONNRESET from redis". Only codes
 * already in the table are known, so a code that was never logged is not
 * recognized.
 */

/** Lower-cased code → the code as stored. */
export type KnownCodes = Map<string, string>;

/** The distinct codes in the query, as stored in logs.error_code, in query order. */
export function codesIn(text: string, known: KnownCodes): string[] {
   const out: string[] = [];
   for (const token of text.split(/[^A-Za-z0-9_]+/)) {
      const code = known.get(token.toLowerCase());
      if (code && !out.includes(code)) out.push(code);
   }
   return out;
}

/**
 * Every distinct error_code, read with a skip scan over
 * idx_logs_error_code (migration 20261118130000): one index probe per
 * distinct code instead of a scan of the table. Postgres has no skip scan of
 * its own before version 18, hence the recursive CTE.
 */
export async function knownCodes(db: Knex | Knex.Transaction): Promise<KnownCodes> {
   const { rows } = await db.raw(`
      WITH RECURSIVE codes AS (
         (SELECT error_code FROM logs WHERE error_code IS NOT NULL ORDER BY error_code LIMIT 1)
         UNION ALL
         SELECT (SELECT l.error_code FROM logs l
                 WHERE l.error_code IS NOT NULL AND l.error_code > c.error_code
                 ORDER BY l.error_code LIMIT 1)
         FROM codes c WHERE c.error_code IS NOT NULL
      )
      SELECT error_code FROM codes WHERE error_code IS NOT NULL`);
   return new Map(rows.map((r: any) => [r.error_code.toLowerCase(), r.error_code]));
}
