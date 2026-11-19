import { Knex } from "knex";
import { toPgVector } from "../embeddings/embedder";

/**
 * The four ways to search logs compared in the semantic search chapter.
 *
 * Every function takes the connection to run on, because callers control
 * planner settings per transaction (SET LOCAL hnsw.ef_search, or turning
 * index scans off for exact search). `excludeId` drops the query's own row
 * when the query IS a log (the evals); pass null for free-text searches.
 *
 * `notInfo` leaves INFO logs out. It defaults to false (every row), which is
 * what the evals measure; GET /search/logs turns it on unless include_info.
 */

/**
 * The partial HNSW index's predicate (migration 20261118120000). The planner
 * uses that index only when the query's WHERE implies it, so this text must
 * stay the same as the index's.
 */
export const NOT_INFO = "level <> 'INFO'";

export interface Hit {
   id: number;
   root_cause: string | null;
}

export type Conn = Knex | Knex.Transaction;

const hits = (rows: any[]): Hit[] => rows.map((r) => ({ id: Number(r.id), root_cause: r.root_cause }));

/**
 * Keyword search over the GIN index: an OR of every lexeme in `text`,
 * ranked by ts_rank_cd (more matching words, closer together, rank higher).
 *
 * OR, not AND: logs carry ids, IPs and durations, so an AND of all words
 * would only ever match exact copies. The lexemes go straight into a
 * ::tsquery cast (each one quoted) instead of to_tsquery(), so punctuation in
 * log text ("x.java:10", quotes) can't break the tsquery syntax, and words
 * aren't stemmed twice.
 */
const OR_TSQUERY = `(SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery
                     FROM unnest(to_tsvector('english', :text)))`;

export async function fullTextSearch(
   db: Conn,
   text: string,
   k: number,
   excludeId: number | null = null,
   notInfo = false,
): Promise<Hit[]> {
   const { rows } = await db.raw(
      `SELECT l.id, l.root_cause
       FROM logs l
       WHERE to_tsvector('english', l.message) @@ ${OR_TSQUERY}
         AND l.id <> :exclude ${notInfo ? `AND l.${NOT_INFO}` : ""}
       ORDER BY ts_rank_cd(to_tsvector('english', l.message), ${OR_TSQUERY}) DESC, l.id
       LIMIT :k`,
      { text, k, exclude: excludeId ?? 0 },
   );
   return hits(rows);
}

/**
 * Substring search, the "grep" baseline. LIKE has no notion of relevance, so
 * matches come newest first, like a log viewer. `pattern` must already be a
 * LIKE pattern with wildcards escaped (see likePattern in evals/metrics).
 */
export async function likeSearch(
   db: Conn,
   pattern: string,
   k: number,
   excludeId: number | null = null,
   notInfo = false,
): Promise<Hit[]> {
   const { rows } = await db.raw(
      `SELECT id, root_cause FROM logs
       WHERE message ILIKE :pattern AND id <> :exclude ${notInfo ? `AND ${NOT_INFO}` : ""}
       ORDER BY id DESC
       LIMIT :k`,
      { pattern, k, exclude: excludeId ?? 0 },
   );
   return hits(rows);
}

/**
 * Nearest neighbors by cosine distance. Exact or approximate depends only
 * on the planner: with an HNSW index (and index scans enabled) this is an
 * HNSW search tuned by hnsw.ef_search; without one it is a full scan.
 *
 * The self-exclusion is done here in JS, not in SQL: a `WHERE id <> x` is
 * applied AFTER the index returns its ef_search candidates, so with
 * ef_search = k it would silently return k - 1 rows.
 */
export async function vectorSearch(
   db: Conn,
   embedding: ArrayLike<number> | string,
   k: number,
   excludeId: number | null = null,
   notInfo = false,
): Promise<Hit[]> {
   const vec = typeof embedding === "string" ? embedding : toPgVector(embedding);
   const { rows } = await db.raw(
      `SELECT id, root_cause FROM logs ${notInfo ? `WHERE ${NOT_INFO}` : ""}
       ORDER BY embedding <=> :vec::vector LIMIT :limit`,
      { vec, limit: excludeId === null ? k : k + 1 },
   );
   return hits(rows)
      .filter((h) => h.id !== excludeId)
      .slice(0, k);
}

/**
 * Hybrid search with Reciprocal Rank Fusion, in one SQL statement.
 *
 * Each side (vector via HNSW, keywords via GIN) contributes its own top
 * `candidates`; a row scores sum(1 / (rrfK + rank)) over the lists it is in.
 * RRF only looks at ranks, so it needs no calibration between cosine
 * distances and ts_rank scores, which live on unrelated scales.
 * rrfK = 60 is the constant from the original RRF paper (Cormack et al.,
 * 2009): it damps the difference between rank 1 and rank 2.
 *
 * With HNSW, hnsw.ef_search must be >= candidates or the vector side returns
 * fewer rows than asked.
 *
 * `codes` (error codes found in the query, src/search/codes.ts) adds a third
 * list: the newest `candidates` logs whose error_code is one of them, read
 * from idx_logs_error_code. Many codes never appear in the message text, so
 * neither of the other two lists can find them. With no codes the list is
 * empty and the result is the same as without it.
 *
 * `templateWeight` > 0 adds a fourth list from log_templates (pnpm
 * templates:build): the `templates` nearest templates by exact distance
 * (their embeddings include the LLM-written descriptions), and the newest
 * logs of each, interleaved: every template's newest log first, then every
 * template's second newest, and so on. Interleaved so a wrong nearest
 * template can't take every slot of the list. This list finds logs whose
 * own words don't match the query but whose template's description does.
 * With no templates built the list is empty.
 */
export async function hybridSearch(
   db: Conn,
   text: string,
   embedding: ArrayLike<number> | string,
   k: number,
   excludeId: number | null = null,
   {
      candidates = 40,
      rrfK = 60,
      vectorWeight = 1.0,
      keywordWeight = 1.0,
      notInfo = false,
      codes = [] as string[],
      codeWeight = 1.0,
      templateWeight = 0,
      templates = 3,
   } = {},
): Promise<Hit[]> {
   const vec = typeof embedding === "string" ? embedding : toPgVector(embedding);

   const { rows } = await db.raw(
      `WITH vector AS (
          SELECT id, row_number() OVER (ORDER BY distance, id) AS rank
          FROM (SELECT id, embedding <=> :vec::vector AS distance
                FROM logs ${notInfo ? `WHERE ${NOT_INFO}` : ""}
                ORDER BY embedding <=> :vec::vector LIMIT :candidates) v
       ),
       keyword AS (
          SELECT id, row_number() OVER (ORDER BY score DESC, id) AS rank
          FROM (SELECT l.id, ts_rank_cd(to_tsvector('english', l.message), ${OR_TSQUERY}) AS score
                FROM logs l
                WHERE to_tsvector('english', l.message) @@ ${OR_TSQUERY} ${notInfo ? `AND l.${NOT_INFO}` : ""}
                ORDER BY score DESC, l.id LIMIT :candidates) t
       ),
       code AS (
          SELECT id, row_number() OVER (ORDER BY id DESC) AS rank
          FROM (SELECT l.id
                FROM jsonb_array_elements_text(:codes::jsonb) AS c(code)
                CROSS JOIN LATERAL (
                   SELECT id FROM logs
                   WHERE error_code = c.code ${notInfo ? `AND ${NOT_INFO}` : ""}
                   ORDER BY id DESC LIMIT :candidates
                ) l
                ORDER BY l.id DESC LIMIT :candidates) c
       ),
       nearest_template AS (
          SELECT id, row_number() OVER (ORDER BY embedding <=> :vec::vector, id) AS trank
          FROM log_templates
          WHERE :templateWeight::float8 > 0 AND embedding IS NOT NULL ${notInfo ? "AND partition NOT LIKE 'INFO|%'" : ""}
          ORDER BY embedding <=> :vec::vector, id
          LIMIT :templates
       ),
       template AS (
          SELECT id, row_number() OVER (ORDER BY lrank, trank) AS rank
          FROM (SELECT m.log_id AS id, t.trank, m.lrank
                FROM nearest_template t
                CROSS JOIN LATERAL (
                   SELECT log_id, row_number() OVER (ORDER BY log_id DESC) AS lrank
                   FROM log_template_map
                   WHERE template_id = t.id
                   ORDER BY log_id DESC
                   LIMIT :candidates
                ) m) x
          ORDER BY lrank, trank
          LIMIT :candidates
       ),
       fused AS (
          SELECT id, sum(weight / (:rrfK + rank)) AS score
          FROM (
            SELECT id, rank, :vectorWeight::float8  AS weight FROM vector
            UNION ALL
            SELECT id, rank, :keywordWeight::float8 AS weight FROM keyword
            UNION ALL
            SELECT id, rank, :codeWeight::float8    AS weight FROM code
            UNION ALL
            SELECT id, rank, :templateWeight::float8 AS weight FROM template
          ) u
          WHERE id <> :exclude
          GROUP BY id
       )
       SELECT f.id, l.root_cause
       FROM fused f JOIN logs l USING (id)
       ORDER BY f.score DESC, f.id
       LIMIT :k`,
      { vec, text, k, candidates, rrfK, vectorWeight, keywordWeight, codes: JSON.stringify(codes), codeWeight, templateWeight, templates, exclude: excludeId ?? 0 },
   );
   return hits(rows);
}
