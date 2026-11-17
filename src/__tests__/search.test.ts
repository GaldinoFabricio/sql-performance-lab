import { existsSync } from "fs";
import path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import db from "../db/knex";
import { modelDir } from "../embeddings/model";
import { buildTemplates, embedTemplates } from "../search/templates";

// Search tests need the model (for typed queries) and embedded logs. CI runs
// `pnpm model:fetch`, `seed:run` and `embed:logs` first; locally, without
// them, the search tests are skipped instead of failing.
const hasModel = existsSync(path.join(modelDir(), "onnx/model_quantized.onnx"));
await db.migrate.latest();
const { rows: [counts] } = await db.raw(
   "SELECT count(*) AS total, count(embedding) AS embedded FROM logs",
);
const ready = hasModel && Number(counts.total) > 0 && Number(counts.embedded) === Number(counts.total);
if (!ready) console.warn("search tests skipped: run pnpm model:fetch, seed:run and embed:logs");

afterAll(async () => {
   await db.destroy();
});

const search = (query: Record<string, string | number>) => request(app).get("/search/logs").query(query);

async function rootCauses(ids: number[]): Promise<(string | null)[]> {
   const { rows } = await db.raw("SELECT id, root_cause FROM logs WHERE id = ANY(?::bigint[])", [ids]);
   const byId = new Map(rows.map((r: any) => [Number(r.id), r.root_cause]));
   return ids.map((id) => byId.get(id) as string | null);
}

describe("GET /search/logs: validação", () => {
   it.each([
      [{}, /q is required/],
      [{ q: "   " }, /q is required/],
      [{ q: "x".repeat(501) }, /at most 500/],
      [{ q: "redis", mode: "semantic" }, /mode must be one of/],
      [{ q: "redis", k: 0 }, /k must be/],
      [{ q: "redis", k: 51 }, /k must be/],
      [{ q: "redis", k: "dez" }, /k must be/],
      [{ q: "redis", ef_search: 5 }, /ef_search must be/],
      [{ q: "redis", vw: 6 }, /vw must be a number between 0 and 5/],
      [{ q: "redis", fw: "abc" }, /fw must be a number between 0 and 5/],
      [{ q: "redis", rrf_k: 0 }, /rrf_k must be an integer between 1 and 1000/],
      [{ q: "redis", route: "talvez" }, /route must be true or false/],
      [{ q: "redis", vw: 0, fw: 0 }, /vw and fw cannot both be 0/],
      [{ q: "redis", ef_serach: 1000 }, /unknown parameter ef_serach; allowed: q, mode, k/],
   ])("400 para %j", async (query, message) => {
      const res = await search(query as Record<string, string | number>);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
   });
});

describe.skipIf(!ready)("GET /search/logs: resultados", () => {
   beforeAll(async () => {
      // Load the model once so the first test's timing isn't the cold start.
      await search({ q: "warm up", mode: "vector", k: 1 });
   }, 60_000);

   it("hybrid é o modo padrão e devolve k logs sem repetir, sem expor root_cause", async () => {
      const res = await search({ q: "redis is down" });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("hybrid");
      expect(res.body.k).toBe(10);
      expect(res.body.results).toHaveLength(10);
      const ids = res.body.results.map((r: any) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of res.body.results) {
         expect(r).toEqual(
            expect.objectContaining({ id: expect.any(Number), service: expect.any(String), message: expect.any(String) }),
         );
         expect(r).not.toHaveProperty("root_cause");
      }
      expect(res.body.ms).toEqual({ embed: expect.any(Number), search: expect.any(Number), total: expect.any(Number) });
   });

   it("respeita k", async () => {
      const res = await search({ q: "deadlock detected", mode: "vector", k: 3 });
      expect(res.body.results).toHaveLength(3);
   });

   it("vector entende paráfrase: 'server ran out of RAM' acha out_of_memory sem palavras em comum", async () => {
      const res = await search({ q: "server ran out of RAM and crashed", mode: "vector" });

      expect(res.status).toBe(200);
      const causes = await rootCauses(res.body.results.map((r: any) => r.id));
      expect(causes.filter((c) => c === "out_of_memory").length).toBeGreaterThanOrEqual(8);
   });

   it("fulltext acha o código exato onde o vetor falha (x509)", async () => {
      const res = await search({ q: "x509", mode: "fulltext" });

      expect(res.status).toBe(200);
      expect(res.body.ef_search).toBeNull();
      expect(res.body.results.length).toBeGreaterThan(0);
      for (const r of res.body.results) expect(r.message).toMatch(/x509/i);
   });

   it("hybrid traz o código exato para o topo (ECONNRESET)", async () => {
      const res = await search({ q: "ECONNRESET", mode: "hybrid" });

      expect(res.body.results[0].message).toMatch(/ECONNRESET/);
   });

   it("like faz busca por substring, sem ranking", async () => {
      const res = await search({ q: "Health check OK", mode: "like", k: 5 });

      expect(res.body.results).toHaveLength(5);
      for (const r of res.body.results) expect(r.message).toContain("Health check OK");
   });

   it("like trata % e _ como texto, não como curinga", async () => {
      const res = await search({ q: "100%_no_such_log", mode: "like" });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(0);
   });

   it("ef_search do hybrid nunca fica abaixo do número de candidatos do lado vetorial", async () => {
      const res = await search({ q: "disk full", mode: "hybrid", ef_search: 10 });

      expect(res.body.ef_search).toBe(40);
      expect(res.body.results).toHaveLength(10);
   });

   it("hybrid roteado: frase favorece o vetor (customers cannot pay → pagamento)", async () => {
      const res = await search({ q: "customers cannot pay", route: "true" });

      expect(res.status).toBe(200);
      expect(res.body.hybrid).toEqual({ vector_weight: 1, keyword_weight: 0.5, weights_from: "routed", rrf_k: 60 });
      const causes = await rootCauses(res.body.results.map((r: any) => r.id));
      expect(causes.filter((c) => c === "payment_gateway_5xx").length).toBeGreaterThanOrEqual(8);
   });

   it("hybrid roteado: código favorece o full-text (ECONNRESET nos 10 resultados)", async () => {
      const res = await search({ q: "ECONNRESET", route: "true" });

      expect(res.body.hybrid).toEqual({ vector_weight: 0.5, keyword_weight: 1, weights_from: "routed", rrf_k: 60 });
      expect(res.body.results).toHaveLength(10);
      for (const r of res.body.results) expect(r.message).toMatch(/ECONNRESET/);
   });

   it("vw/fw explícitos sempre ganham do roteamento", async () => {
      const res = await search({ q: "ECONNRESET", vw: 2, fw: 0.25, route: "true" });
      expect(res.body.hybrid).toMatchObject({ vector_weight: 2, keyword_weight: 0.25, weights_from: "explicit" });

      // só um dos dois: o outro fica no padrão fixo, sem roteamento
      const half = await search({ q: "ECONNRESET", vw: 1, route: "true" });
      expect(half.body.hybrid).toMatchObject({ vector_weight: 1, keyword_weight: 1, weights_from: "explicit" });
   });

   it("sem route, o hybrid usa os pesos fixos 1/1 (roteamento desligado por padrão)", async () => {
      const res = await search({ q: "ECONNRESET" });
      expect(res.body.hybrid).toEqual({ vector_weight: 1, keyword_weight: 1, weights_from: "fixed", rrf_k: 60 });

      const off = await search({ q: "ECONNRESET", route: "false" });
      expect(off.body.hybrid).toMatchObject({ weights_from: "fixed" });
   });

   it("hybrid é null fora do modo hybrid", async () => {
      const res = await search({ q: "ECONNRESET", mode: "fulltext" });
      expect(res.body.hybrid).toBeNull();
   });

   it("ef_search é por transação e não vaza para outras conexões", async () => {
      await search({ q: "disk full", mode: "vector", ef_search: 777 });
      const { rows } = await db.raw("SHOW hnsw.ef_search");
      expect(rows[0]["hnsw.ef_search"]).not.toBe("777");
   });
});

describe.skipIf(!ready)("GET /search/logs: mode=template", () => {
   beforeAll(async () => {
      await buildTemplates(db);
      await embedTemplates(db);
   });

   // The two queries where HNSW lost every relevant log (pnpm eval:hnsw-dive):
   // the template vectors are few enough for exact search.
   it.each([
      ["redis is down", "cache_unavailable"],
      ["too many requests", "rate_limited"],
   ])("%s → 10 logs de %s", async (q, cause) => {
      const res = await search({ q, mode: "template" });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(10);
      const causes = await rootCauses(res.body.results.map((r: any) => r.id));
      expect(causes.every((c) => c === cause)).toBe(true);
   });

   it("cada resultado diz por qual modelo veio, sem ef_search nem root_cause", async () => {
      const res = await search({ q: "server ran out of RAM and crashed", mode: "template", k: 5 });
      expect(res.body.ef_search).toBeNull();
      expect(res.body.results).toHaveLength(5);
      for (const r of res.body.results) {
         expect(r.template).toMatchObject({ id: expect.any(Number), text: expect.any(String), log_count: expect.any(Number) });
         expect(r).not.toHaveProperty("root_cause");
      }
      // nearest template first; inside a template, newest log first
      const [a, b] = res.body.results;
      expect(a.template.distance).toBeLessThanOrEqual(b.template.distance);
      if (a.template.id === b.template.id) expect(a.id).toBeGreaterThan(b.id);
   });

   it("os resultados vêm de vários modelos quando o primeiro tem menos de k logs", async () => {
      const res = await search({ q: "certificate has expired", mode: "template", k: 50 });
      const templates = new Set(res.body.results.map((r: any) => r.template.id));
      expect(res.body.results).toHaveLength(50);
      expect(templates.size).toBeGreaterThan(1);
   });
});
