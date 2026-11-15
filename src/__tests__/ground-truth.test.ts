import { describe, it, expect } from "vitest";
import { compareTopK, cosineDistance, exactTopK, sampleQueryIds } from "../evals/ground-truth";

describe("sampleQueryIds", () => {
   const ids = Array.from({ length: 1000 }, (_, i) => i + 1);

   it("é determinístico e não depende da ordem das linhas", () => {
      const a = sampleQueryIds(ids, 100, 42);
      expect(sampleQueryIds([...ids].reverse(), 100, 42)).toEqual(a);
      expect(sampleQueryIds(ids, 100, 7)).not.toEqual(a);
   });

   it("devolve ids distintos e ordenados", () => {
      const a = sampleQueryIds(ids, 100, 42);
      expect(new Set(a).size).toBe(100);
      expect(a).toEqual([...a].sort((x, y) => x - y));
   });

   it("falha se pedirem mais consultas que linhas", () => {
      expect(() => sampleQueryIds([1, 2], 3, 42)).toThrow();
   });
});

describe("exactTopK", () => {
   const corpus = new Map<number, number[]>([
      [1, [1, 0]],
      [2, [0.9, 0.1]],
      [3, [0, 1]],
      [4, [0.9, 0.1]], // duplicate of 2
      [5, [-1, 0]],
   ]);

   it("ordena por distância de cosseno e exclui a própria consulta", () => {
      const top = exactTopK(1, corpus.get(1)!, corpus, 3);
      expect(top.map((n) => n.id)).toEqual([2, 4, 3]);
      expect(top[0].distance).toBeCloseTo(cosineDistance([1, 0], [0.9, 0.1]), 12);
   });

   it("desempata pelo id, igual ao ORDER BY do SQL", () => {
      const top = exactTopK(1, corpus.get(1)!, corpus, 1);
      expect(top.map((n) => n.id)).toEqual([2]);
   });
});

describe("compareTopK", () => {
   it("aceita diferenças de arredondamento float32 vs float64", () => {
      const a = [{ id: 1, distance: 0.1 }, { id: 2, distance: 0.2 }];
      const b = [{ id: 1, distance: 0.1000001 }, { id: 2, distance: 0.2000001 }];
      expect(compareTopK(a, b)).toBeNull();
   });

   it("aceita ids diferentes só quando empatados na fronteira k", () => {
      const a = [{ id: 1, distance: 0.1 }, { id: 2, distance: 0.3 }];
      const tied = [{ id: 1, distance: 0.1 }, { id: 9, distance: 0.3 }];
      expect(compareTopK(a, tied)).toBeNull();

      const swapped = [{ id: 9, distance: 0.1 }, { id: 2, distance: 0.3 }];
      expect(compareTopK(a, swapped)).toMatch(/only one list/);
   });

   it("rejeita distâncias diferentes", () => {
      expect(compareTopK([{ id: 1, distance: 0.1 }], [{ id: 1, distance: 0.2 }])).toMatch(/rank 1/);
   });
});
