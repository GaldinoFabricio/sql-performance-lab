/**
 * Query routing for the hybrid search: pick the RRF weights per query.
 *
 * Why per query: the vector list and the full-text list rarely share rows, so
 * RRF with fixed weights interleaves them in the same pattern whether the right
 * answer is in one list or the other. Embeddings fail on bare codes
 * ("ECONNRESET", "x509"); full-text fails on paraphrases ("customers cannot pay").
 * So we guess which kind of query it is and favor the list that handles it.
 */

export interface RouteWeights {
   vectorWeight: number;
   keywordWeight: number;
}

/**
 * Weights, assuming rrf_k = 60 and lists with no rows in common.
 *
 * A row at rank r of a list with weight w scores w / (60 + r). For the favored
 * list (weight F) to fill the top 10 alone, its 10th row must beat the other
 * list's 1st row (weight O):
 *
 *    F / (60 + 10) > O / (60 + 1)   ⇔   F / O > 70 / 61 ≈ 1.15
 *
 * F / O = 2 is far above that, so the top 10 comes from the favored list even
 * if the ranks move a bit. The other list keeps weight 0.5 instead of 0 for
 * two reasons:
 *  - a row found by BOTH lists still gets the extra score and moves up;
 *  - if the favored list returns fewer than 10 rows (full-text with no match),
 *    the other list fills the remaining places instead of returning nothing.
 */
export const FAVORED = 1.0;
export const OTHER = 0.5;

/**
 * Does this token look like an error code or identifier rather than a word?
 *   ECONNRESET, HTTPS     all capitals, 3+ characters
 *   HTTP_502, users_email underscore
 *   x509, 23505           has a digit (letters + digits, or a number of 3+ digits)
 *   NullPointerException  lowercase letter followed by a capital (camelCase)
 *   java.lang.Error       dot between two word characters
 */
function looksLikeCodeToken(token: string): boolean {
   return (
      /^[A-Z][A-Z0-9]{2,}$/.test(token) ||
      token.includes("_") ||
      /[A-Za-z]\d|\d[A-Za-z]/.test(token) ||
      /^\d{3,}$/.test(token) ||
      /[a-z][A-Z]/.test(token) ||
      /\w\.\w/.test(token)
   );
}

/**
 * true when the query contains a token that looks like a code; false for plain
 * words. Simple on purpose: it only looks at the shape of each token, so it
 * does not know lowercase codes ("econnreset") and treats a capitalized word
 * inside a sentence ("HTTPS certificate is no longer valid") as a code.
 */
export function looksLikeIdentifier(q: string): boolean {
   const tokens = q
      .trim()
      .split(/\s+/)
      // strip punctuation around the token: "ECONNRESET," or "(x509)"
      .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ""))
      .filter(Boolean);
   return tokens.some(looksLikeCodeToken);
}

/** Identifier → favor full-text; natural language → favor vectors. */
export function routeWeights(q: string): RouteWeights {
   return looksLikeIdentifier(q)
      ? { vectorWeight: OTHER, keywordWeight: FAVORED }
      : { vectorWeight: FAVORED, keywordWeight: OTHER };
}
