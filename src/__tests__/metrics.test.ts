import { describe, it, expect } from "vitest";
import { likePattern, percentile, precisionAtK, recallAtK } from "../evals/metrics";

describe("recallAtK (com empates)", () => {
   const truth = { id: 1, kth_distance: 0.3 };

   it("conta como acerto qualquer linha tão perto quanto o k-ésimo vizinho exato", () => {
      const returned = [
         { id: 2, distance: 0.1 },
         { id: 99, distance: 0.3 }, // not in the stored top-k, but tied with the k-th
         { id: 3, distance: 0.5 },
      ];
      expect(recallAtK(returned, truth, 2)).toBe(1);
      expect(recallAtK(returned, truth, 3)).toBeCloseTo(2 / 3);
   });

   it("ignora a própria consulta e ids repetidos", () => {
      const returned = [
         { id: 1, distance: 0 },
         { id: 2, distance: 0.1 },
         { id: 2, distance: 0.1 },
      ];
      expect(recallAtK(returned, truth, 2)).toBe(0.5);
   });

   it("menos resultados que k contam como erro", () => {
      expect(recallAtK([{ id: 2, distance: 0.1 }], truth, 10)).toBe(0.1);
   });
});

describe("precisionAtK", () => {
   it("divide por k, não pelo número de resultados", () => {
      expect(precisionAtK(["a", "a", "b"], "a", 10)).toBe(0.2);
      expect(precisionAtK(["a", "a"], "a", 2)).toBe(1);
   });
});

describe("percentile", () => {
   it("usa nearest-rank", () => {
      const v = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(percentile(v, 50)).toBe(50);
      expect(percentile(v, 95)).toBe(95);
      expect(percentile([7], 95)).toBe(7);
   });
});

describe("likePattern", () => {
   it("usa as 3 primeiras palavras da primeira linha", () => {
      expect(likePattern("TypeError: Cannot read properties of null\n    at X.y (a.ts:1:2)")).toBe(
         "%TypeError: Cannot read%",
      );
   });

   it("escapa os curingas do LIKE", () => {
      expect(likePattern("rate_limit 100% hit")).toBe("%rate\\_limit 100\\% hit%");
   });
});
