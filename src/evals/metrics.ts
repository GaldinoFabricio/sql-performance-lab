import { DISTANCE_EPS, GroundTruthQuery } from "./ground-truth";

/**
 * Metrics for the search experiments. All pure, so they are unit-tested
 * without a database.
 */

/**
 * Tie-aware recall@k against the exact ground truth.
 *
 * `returned` carries each result's TRUE distance to the query (recomputed
 * exactly, not the index's own estimate). A result is a hit when it is at
 * least as close as the k-th exact neighbor: with duplicates, any of the
 * tied rows is an equally correct answer (see evals/README.md, "Ties").
 */
export function recallAtK(
   returned: { id: number; distance: number }[],
   truth: Pick<GroundTruthQuery, "id" | "kth_distance">,
   k: number,
   eps = DISTANCE_EPS,
): number {
   const seen = new Set<number>();
   let hits = 0;
   for (const r of returned) {
      if (r.id === truth.id || seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.distance <= truth.kth_distance + eps) hits++;
      if (seen.size === k) break;
   }
   return Math.min(hits, k) / k;
}

/**
 * Relevance proxy: share of the k slots filled with a log of the expected
 * root cause. Divides by k, not by the number returned, so a method that
 * returns 3 good results out of 10 slots scores 0.3, not 1.0.
 */
export function precisionAtK(rootCauses: (string | null)[], expected: string | null, k: number): number {
   return rootCauses.slice(0, k).filter((r) => r === expected).length / k;
}

/** Nearest-rank percentile (p in 0..100). Same definition at every scale, no interpolation. */
export function percentile(values: number[], p: number): number {
   if (values.length === 0) return NaN;
   const sorted = [...values].sort((a, b) => a - b);
   const rank = Math.ceil((p / 100) * sorted.length);
   return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function mean(values: number[]): number {
   return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

/**
 * LIKE baseline: what someone pasting a fragment of the error would type.
 * First 3 words of the first line (stack traces are dropped), with LIKE's
 * wildcards escaped so a literal "_" or "%" in the log can't widen the match.
 */
export function likePattern(message: string, words = 3): string {
   const fragment = message.split("\n")[0].trim().split(/\s+/).slice(0, words).join(" ");
   return `%${fragment.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
