import { describe, it, expect } from "vitest";
import { FAVORED, OTHER, looksLikeIdentifier, routeWeights } from "./routing";

// Expected values are what we WANT, not what the regex does today.
// Failing cases are known limits of the simple token-shape rule.
describe("looksLikeIdentifier", () => {
   const identifiers = [
      "ECONNRESET",
      "HTTP_502",
      "x509",
      "NullPointerException",
      "CERT_HAS_EXPIRED",
      "users_email_unique",
      "KnexTimeoutError",
      "23505",
      "java.lang.OutOfMemoryError",
      "ECONNREFUSED on checkout",
      "(x509),",
      "econnreset", // lowercase code: no shape to recognize
      "OOMKilled", // capitals then lowercase, no camelCase boundary
   ];
   it.each(identifiers)("%s → identificador", (q) => {
      expect(looksLikeIdentifier(q)).toBe(true);
   });

   const naturalLanguage = [
      "customers cannot pay",
      "too many requests",
      "connection refused",
      "Payment",
      "server ran out of memory",
      "",
      "   ",
      "HTTPS certificate is no longer valid", // sentence with an acronym
      "partner API is throttling our calls", // sentence with an acronym
      "server ran out of RAM and crashed", // sentence with an acronym
   ];
   it.each(naturalLanguage)("%j → linguagem natural", (q) => {
      expect(looksLikeIdentifier(q)).toBe(false);
   });
});

describe("routeWeights", () => {
   it("identificador favorece o full-text", () => {
      expect(routeWeights("ECONNRESET")).toEqual({ vectorWeight: OTHER, keywordWeight: FAVORED });
   });

   it("linguagem natural favorece o vetor", () => {
      expect(routeWeights("customers cannot pay")).toEqual({ vectorWeight: FAVORED, keywordWeight: OTHER });
   });

   it("a razão entre os pesos passa do limite 70/61 (rrf_k = 60, top 10)", () => {
      // favored rank 10 must beat the other list's rank 1: F/70 > O/61
      expect(FAVORED / (60 + 10)).toBeGreaterThan(OTHER / (60 + 1));
   });
});
