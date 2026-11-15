import { describe, it, expect } from "vitest";
import { generateLogs, ROOT_CAUSE_NAMES } from "../logs/generator";

const sample = (count: number, seed?: number) => [...generateLogs({ count, seed })];

describe("generateLogs", () => {
   it("é determinístico para a mesma seed (evals dependem disso)", () => {
      expect(sample(500)).toEqual(sample(500));
      expect(sample(500, 7)).not.toEqual(sample(500));
   });

   it("gera logs em ordem cronológica", () => {
      const logs = sample(2000);
      for (let i = 1; i < logs.length; i++) {
         expect(logs[i].created_at.getTime()).toBeGreaterThanOrEqual(
            logs[i - 1].created_at.getTime(),
         );
      }
   });

   it("INFO é a maioria, como em sistemas reais", () => {
      const logs = sample(20_000);
      const info = logs.filter((l) => l.level === "INFO").length / logs.length;
      expect(info).toBeGreaterThan(0.65);
      expect(info).toBeLessThan(0.8);
   });

   it("cobre todas as causas raiz", () => {
      const seen = new Set(sample(20_000).map((l) => l.root_cause));
      expect([...seen].sort()).toEqual([...ROOT_CAUSE_NAMES].sort());
   });

   it("o mesmo problema aparece com textos e códigos diferentes", () => {
      const db = sample(20_000).filter(
         (l) => l.root_cause === "db_connection_timeout",
      );
      const codes = new Set(db.map((l) => l.error_code));
      const firstWords = new Set(db.map((l) => l.message.split(" ")[0]));

      expect(codes.size).toBeGreaterThanOrEqual(4);
      expect(firstWords.size).toBeGreaterThanOrEqual(4);
      expect(db.some((l) => l.message.includes("\n    at "))).toBe(true);
   });

   it("logs não-INFO têm error_code", () => {
      const errors = sample(5000).filter((l) => l.level === "ERROR" || l.level === "FATAL");
      const withCode = errors.filter((l) => l.error_code !== null).length;
      expect(withCode / errors.length).toBeGreaterThan(0.95);
   });
});
