import { describe, it, expect } from "vitest";
import { FAVORED, OTHER, looksLikeIdentifier, routeWeights } from "../search/routing";

// Expected values are what we WANT, not what the regex does today.
// The known limits of the simple token-shape rule are `it.fails`: they document
// the gap and keep CI green, and turn red if a better rule starts getting them right.
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
   ];
   it.each(identifiers)("%s → identificador", (q) => {
      expect(looksLikeIdentifier(q)).toBe(true);
   });

   const missedIdentifiers = [
      "econnreset", // lowercase code: no shape to recognize
      "OOMKilled", // capitals then lowercase, no camelCase boundary
   ];
   it.fails.each(missedIdentifiers)("limite conhecido: %s → identificador", (q) => {
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
   ];
   it.each(naturalLanguage)("%j → linguagem natural", (q) => {
      expect(looksLikeIdentifier(q)).toBe(false);
   });

   // A sentence with an all-caps acronym: the acronym looks like a code.
   const missedNaturalLanguage = [
      "HTTPS certificate is no longer valid",
      "partner API is throttling our calls",
      "server ran out of RAM and crashed",
   ];
   it.fails.each(missedNaturalLanguage)("limite conhecido: %j → linguagem natural", (q) => {
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
