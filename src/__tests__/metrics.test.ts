import { describe, it, expect } from "vitest";
import {
   isRelevant,
   likePattern,
   meanReciprocalRank,
   percentile,
   precisionAtK,
   recallAtK,
   reciprocalRank,
} from "../evals/metrics";

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

   it("aceita mais de uma causa relevante (consulta ambígua)", () => {
      expect(precisionAtK(["a", "b", "c", null], ["a", "b"], 4)).toBe(0.5);
      const q = { expected: "db", also: ["cache"] };
      expect(isRelevant(q, "cache")).toBe(true);
      expect(isRelevant(q, "dns")).toBe(false);
      expect(isRelevant({ expected: "db" }, null)).toBe(false);
   });
});

describe("precisionAtK com causa raiz null", () => {
   it("null nunca conta como acerto, mesmo se expected contém null", () => {
      expect(precisionAtK([null, "a", null], [null, "a"], 4)).toBe(0.25);
      expect(precisionAtK([null, null], null, 2)).toBe(0);
   });
});

describe("reciprocalRank", () => {
   it("primeiro resultado relevante vale 1", () => {
      expect(reciprocalRank(["a", "b"], "a", 10)).toBe(1);
   });

   it("vale 1/posição do primeiro relevante", () => {
      expect(reciprocalRank(["x", "y", "a", "a"], "a", 10)).toBeCloseTo(1 / 3);
   });

   it("nada relevante nos k primeiros vale 0, inclusive posição k+1", () => {
      expect(reciprocalRank(["x", "y"], "a", 10)).toBe(0);
      expect(reciprocalRank(["x", "y", "a"], "a", 2)).toBe(0);
      expect(reciprocalRank([], "a", 10)).toBe(0);
   });

   it("com várias causas relevantes, vale a primeira que aparecer", () => {
      expect(reciprocalRank(["x", "cache", "db"], ["db", "cache"], 10)).toBe(0.5);
   });

   it("causa raiz null nunca é relevante", () => {
      expect(reciprocalRank([null, "a"], [null, "a"], 10)).toBe(0.5);
      expect(reciprocalRank([null], null, 10)).toBe(0);
   });
});

describe("meanReciprocalRank", () => {
   it("tira a média dos reciprocal ranks", () => {
      expect(meanReciprocalRank([1, 0.5, 0])).toBeCloseTo(0.5);
   });

   it("lista vazia dá NaN, como mean", () => {
      expect(meanReciprocalRank([])).toBeNaN();
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
