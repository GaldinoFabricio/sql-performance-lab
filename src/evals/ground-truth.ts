import { Faker, base, en } from "@faker-js/faker";

/**
 * Pure helpers for the exact-search ground truth (evals/ground_truth.json).
 *
 * Nothing here touches the database: the script in
 * src/scripts/ground-truth.ts gets the answer from Postgres with a forced
 * sequential scan, and these functions recompute the same answer
 * independently in float64 to prove the two agree.
 */

export const GROUND_TRUTH_VERSION = 1;

/**
 * pgvector accumulates cosine distance in float32; JS uses float64. Two
 * distances closer than this are treated as equal (a tie), so a few ulps of
 * rounding never count as a disagreement.
 */
export const DISTANCE_EPS = 1e-5;

export interface Neighbor {
   id: number;
   distance: number;
}

export interface GroundTruthQuery {
   id: number;
   level: string;
   root_cause: string | null;
   message: string;
   /** Distance of the k-th neighbor: any id at <= kth_distance + eps is a valid top-k answer. */
   kth_distance: number;
   /** Rows outside `neighbors` that are tied with the k-th one (exact duplicates, mostly). */
   ties_beyond_k: number;
   neighbors: (Neighbor & { root_cause: string | null })[];
}

export interface GroundTruth {
   version: number;
   created_at: string;
   model: string;
   metric: "cosine_distance";
   k: number;
   seed: number;
   rows: number;
   /** md5 over (id, embedding) of the whole table; a mismatch means the file is stale. */
   fingerprint: string;
   self_excluded: true;
   queries: GroundTruthQuery[];
}

/** Deterministic sample of `n` distinct ids (sorted), independent of row order. */
export function sampleQueryIds(ids: readonly number[], n: number, seed: number): number[] {
   if (n > ids.length) throw new Error(`cannot sample ${n} queries from ${ids.length} rows`);
   const f = new Faker({ locale: [en, base], seed });
   const sorted = [...ids].sort((a, b) => a - b);
   return f.helpers.arrayElements(sorted, n).sort((a, b) => a - b);
}

export function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
   let dot = 0;
   let na = 0;
   let nb = 0;
   for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
   }
   return 1 - dot / Math.sqrt(na * nb);
}

/**
 * Streaming top-k by (distance, id), the same order the SQL uses. Memory is
 * O(k), so 1M rows can be checked batch by batch without loading the table.
 */
export class TopK {
   private items: Neighbor[] = [];
   constructor(private readonly k: number) {}

   push(n: Neighbor): void {
      const worst = this.items[this.items.length - 1];
      if (this.items.length === this.k && !before(n, worst)) return;
      let i = this.items.length;
      while (i > 0 && before(n, this.items[i - 1])) i--;
      this.items.splice(i, 0, n);
      if (this.items.length > this.k) this.items.pop();
   }

   result(): Neighbor[] {
      return [...this.items];
   }
}

const before = (a: Neighbor, b: Neighbor) => a.distance < b.distance || (a.distance === b.distance && a.id < b.id);

/**
 * Brute force over the whole corpus, float64. The query row itself is excluded.
 */
export function exactTopK(
   queryId: number,
   query: ArrayLike<number>,
   corpus: Iterable<[number, ArrayLike<number>]>,
   k: number,
): Neighbor[] {
   const top = new TopK(k);
   for (const [id, v] of corpus) {
      if (id !== queryId) top.push({ id, distance: cosineDistance(query, v) });
   }
   return top.result();
}

/**
 * Do two top-k lists agree, allowing for ties? Distances must match rank by
 * rank, and an id may only appear in one list if it sits on the tied
 * boundary (where either choice is a correct answer).
 * Returns null when they agree, otherwise a human-readable reason.
 */
export function compareTopK(a: Neighbor[], b: Neighbor[], eps = DISTANCE_EPS): string | null {
   if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
   for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].distance - b[i].distance) > eps) {
         return `rank ${i + 1}: distance ${a[i].distance} vs ${b[i].distance}`;
      }
   }
   const kth = a[a.length - 1]?.distance ?? 0;
   const inB = new Map(b.map((n) => [n.id, n]));
   const inA = new Map(a.map((n) => [n.id, n]));
   for (const n of [...a.filter((x) => !inB.has(x.id)), ...b.filter((x) => !inA.has(x.id))]) {
      if (Math.abs(n.distance - kth) > eps) return `id ${n.id} (distance ${n.distance}) is in only one list`;
   }
   return null;
}

/** Share of neighbors with the same root_cause as the query (a semantic sanity check, not recall). */
export function rootCauseAgreement(q: GroundTruthQuery): number {
   if (q.neighbors.length === 0) return 0;
   return q.neighbors.filter((n) => n.root_cause === q.root_cause).length / q.neighbors.length;
}
