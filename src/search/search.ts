import { Knex } from "knex";
import { toPgVector } from "../embeddings/embedder";

/**
 * The four ways to search logs compared in the semantic search chapter.
 *
 * Every function takes the connection to run on, because callers control
 * planner settings per transaction (SET LOCAL hnsw.ef_search, or turning
 * index scans off for exact search). `excludeId` drops the query's own row
 * when the query IS a log (the evals); pass null for free-text searches.
 */

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

export async function fullTextSearch(db: Conn, text: string, k: number, excludeId: number | null = null): Promise<Hit[]> {
   const { rows } = await db.raw(
      `SELECT l.id, l.root_cause
       FROM logs l
       WHERE to_tsvector('english', l.message) @@ ${OR_TSQUERY}
         AND l.id <> :exclude
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
export async function likeSearch(db: Conn, pattern: string, k: number, excludeId: number | null = null): Promise<Hit[]> {
   const { rows } = await db.raw(
      `SELECT id, root_cause FROM logs
       WHERE message ILIKE :pattern AND id <> :exclude
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
): Promise<Hit[]> {
   const vec = typeof embedding === "string" ? embedding : toPgVector(embedding);
   const { rows } = await db.raw(
      `SELECT id, root_cause FROM logs ORDER BY embedding <=> :vec::vector LIMIT :limit`,
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
 */
export async function hybridSearch(
   db: Conn,
   text: string,
   embedding: ArrayLike<number> | string,
   k: number,
   excludeId: number | null = null,
   { candidates = 40, rrfK = 60, vectorWeight = 1.0, keywordWeight = 1.0 } = {},
): Promise<Hit[]> {
   const vec = typeof embedding === "string" ? embedding : toPgVector(embedding);

   const { rows } = await db.raw(
      `WITH vector AS (
          SELECT id, row_number() OVER (ORDER BY distance, id) AS rank
          FROM (SELECT id, embedding <=> :vec::vector AS distance
                FROM logs ORDER BY embedding <=> :vec::vector LIMIT :candidates) v
       ),
       keyword AS (
          SELECT id, row_number() OVER (ORDER BY score DESC, id) AS rank
          FROM (SELECT l.id, ts_rank_cd(to_tsvector('english', l.message), ${OR_TSQUERY}) AS score
                FROM logs l
                WHERE to_tsvector('english', l.message) @@ ${OR_TSQUERY}
                ORDER BY score DESC, l.id LIMIT :candidates) t
       ),
       fused AS (
          SELECT id, sum(weight / (:rrfK + rank)) AS score
          FROM (
            SELECT id, rank, :vectorWeight::float8  AS weight FROM vector
            UNION ALL
            SELECT id, rank, :keywordWeight::float8 AS weight FROM keyword
          ) u
          WHERE id <> :exclude
          GROUP BY id
       )
       SELECT f.id, l.root_cause
       FROM fused f JOIN logs l USING (id)
       ORDER BY f.score DESC, f.id
       LIMIT :k`,
      { vec, text, k, candidates, rrfK, vectorWeight, keywordWeight, exclude: excludeId ?? 0 },
   );
   return hits(rows);
}
