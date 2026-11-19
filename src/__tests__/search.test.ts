import { existsSync } from "fs";
import path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import db from "../db/knex";
import { modelDir, RERANKER_MODEL } from "../embeddings/model";
import { NOT_INFO } from "../search/search";
import { buildTemplates, embedTemplates } from "../search/templates";

// Search tests need the model (for typed queries) and embedded logs. CI runs
// `pnpm model:fetch`, `seed:run` and `embed:logs` first; locally, without
// them, the search tests are skipped instead of failing.
const hasModel = existsSync(path.join(modelDir(), "onnx/model_quantized.onnx"));
const hasReranker = existsSync(path.join(modelDir(RERANKER_MODEL), "onnx/model.onnx"));
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
      [{ q: "redis", include_info: "talvez" }, /include_info must be true or false/],
      [{ q: "redis", cw: 6 }, /cw must be a number between 0 and 5/],
      [{ q: "redis", vw: 0, fw: 0 }, /vw and fw cannot both be 0/],
      [{ q: "redis", ef_serach: 1000 }, /unknown parameter ef_serach; allowed: q, mode, k/],
      [{ q: "redis", rerank: 101 }, /rerank must be an integer between 0 and 100/],
      [{ q: "redis", rerank: 5 }, /rerank must be 0 \(off\) or at least k/],
      [{ q: "redis", rerank: 20, k: 30 }, /rerank must be 0 \(off\) or at least k/],
      [{ q: "redis", tw: 6 }, /tw must be a number between 0 and 5/],
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
      expect(res.body.ms).toEqual({ embed: expect.any(Number), search: expect.any(Number), rerank: expect.any(Number), total: expect.any(Number) });
      // hybrid reranks the top 50 by default when the reranker model is on disk
      expect(res.body.rerank).toEqual(hasReranker ? { candidates: 50, model: "Xenova/ms-marco-MiniLM-L-6-v2", doc: "template" } : null);
      expect("rerank_score" in res.body.results[0]).toBe(hasReranker);
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
      const res = await search({ q: "Health check OK", mode: "like", k: 5, include_info: "true" });

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
      expect(res.body.hybrid).toEqual({ vector_weight: 1, keyword_weight: 0.5, weights_from: "routed", rrf_k: 60, codes: [], code_weight: 2, template_weight: 0 });
      const causes = await rootCauses(res.body.results.map((r: any) => r.id));
      expect(causes.filter((c) => c === "payment_gateway_5xx").length).toBeGreaterThanOrEqual(8);
   });

   it("hybrid roteado: código favorece o full-text (ECONNRESET nos 10 resultados)", async () => {
      const res = await search({ q: "ECONNRESET", route: "true" });

      expect(res.body.hybrid).toEqual({ vector_weight: 0.5, keyword_weight: 1, weights_from: "routed", rrf_k: 60, codes: ["ECONNRESET"], code_weight: 2, template_weight: 0 });
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
      expect(res.body.hybrid).toEqual({ vector_weight: 1, keyword_weight: 1, weights_from: "fixed", rrf_k: 60, codes: ["ECONNRESET"], code_weight: 2, template_weight: 0 });

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

describe.skipIf(!ready)("GET /search/logs: códigos de erro no hybrid", () => {
   // 40P01 (Postgres deadlock) is only in error_code, never in the message text:
   // without the code list, vectors and full-text can't find it (pnpm eval:codes).
   it("um código que não está no texto acha os logs pelo error_code", async () => {
      const res = await search({ q: "40P01" });
      expect(res.body.hybrid).toMatchObject({ codes: ["40P01"], code_weight: 2 });
      expect(res.body.results).toHaveLength(10);
      expect(res.body.results.every((r: any) => r.error_code === "40P01")).toBe(true);
   });

   it("acha o código em minúsculas dentro de uma frase", async () => {
      const res = await search({ q: "lots of econnreset errors since the deploy" });
      expect(res.body.hybrid.codes).toEqual(["ECONNRESET"]);
      const causes = await rootCauses(res.body.results.map((r: any) => r.id));
      expect(causes.filter((c) => c === "cache_unavailable").length).toBeGreaterThanOrEqual(9);
   });

   it("cw=0 desliga a lista de códigos", async () => {
      // rerank=0: the reranker reads the error code too, so it would still bring 40P01 up
      const res = await search({ q: "40P01", cw: 0, rerank: 0 });
      expect(res.body.hybrid).toMatchObject({ codes: ["40P01"], code_weight: 0 });
      expect(res.body.results.some((r: any) => r.error_code === "40P01")).toBe(false);
   });

   it("sem código na consulta, a lista fica vazia", async () => {
      const res = await search({ q: "redis is down" });
      expect(res.body.hybrid.codes).toEqual([]);
   });

   it("tw liga a lista de templates no hybrid e aparece na resposta", async () => {
      const res = await search({ q: "redis is down", tw: 1 });
      expect(res.status).toBe(200);
      expect(res.body.hybrid.template_weight).toBe(1);
      expect(res.body.results).toHaveLength(10);
   });
});

describe.skipIf(!ready || !hasReranker)("GET /search/logs: rerank", () => {
   it("rerank=N reordena N candidatos e devolve k, da maior nota para a menor", async () => {
      const res = await search({ q: "redis is down", rerank: 30, k: 10 });
      expect(res.status).toBe(200);
      expect(res.body.rerank).toEqual({ candidates: 30, model: "Xenova/ms-marco-MiniLM-L-6-v2", doc: "template" });
      expect(res.body.results).toHaveLength(10);
      const scores = res.body.results.map((r: any) => r.rerank_score);
      expect(scores.every((x: unknown) => typeof x === "number")).toBe(true);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      expect(res.body.ms.rerank).toBeGreaterThan(0);
      expect(await rootCauses(res.body.results.map((r: any) => r.id))).toContain("cache_unavailable");
   }, 30_000);

   it("os resultados com rerank saem dos candidatos sem rerank", async () => {
      const [plain, reranked] = await Promise.all([
         search({ q: "deadlock detected", k: 20 }),
         search({ q: "deadlock detected", rerank: 20, k: 5 }),
      ]);
      const candidates = new Set(plain.body.results.map((r: any) => r.id));
      for (const r of reranked.body.results) expect(candidates.has(r.id)).toBe(true);
   }, 30_000);

   it("rerank=0 desliga o reranker do hybrid", async () => {
      const res = await search({ q: "redis is down", rerank: 0 });
      expect(res.body.rerank).toBeNull();
      expect(res.body.ms.rerank).toBe(0);
      expect(res.body.results[0]).not.toHaveProperty("rerank_score");
   });

   it("os outros modos não reordenam por padrão", async () => {
      for (const mode of ["vector", "fulltext", "like", "template"]) {
         const res = await search({ q: "redis is down", mode });
         if (res.status === 503) continue; // template mode before templates:build
         expect(res.body.rerank).toBeNull();
      }
   });

   it("k maior que o padrão de candidatos: reordena k", async () => {
      const res = await search({ q: "redis is down", k: 50 });
      expect(res.body.rerank.candidates).toBe(50);
      expect(res.body.results).toHaveLength(50);
   }, 30_000);

   it("funciona nos outros modos (vector)", async () => {
      const res = await search({ q: "server ran out of RAM", mode: "vector", rerank: 20 });
      expect(res.status).toBe(200);
      expect(res.body.rerank.candidates).toBe(20);
      expect(res.body.results).toHaveLength(10);
   }, 30_000);
});

async function levels(ids: number[]): Promise<string[]> {
   const { rows } = await db.raw("SELECT level FROM logs WHERE id = ANY(?::bigint[])", [ids]);
   return rows.map((r: any) => r.level);
}

describe.skipIf(!ready)("GET /search/logs: logs INFO", () => {
   // "Health check OK" is an INFO message: the nearest logs, and every LIKE match, are INFO.
   it.each(["vector", "hybrid", "fulltext", "like"])("%s deixa INFO de fora por padrão", async (mode) => {
      const res = await search({ q: "Health check OK", mode });
      expect(res.status).toBe(200);
      expect(res.body.include_info).toBe(false);
      expect(await levels(res.body.results.map((r: any) => r.id))).not.toContain("INFO");
   });

   it("include_info=true acha INFO, numa busca exata (sem ef_search)", async () => {
      const res = await search({ q: "Health check OK", mode: "vector", include_info: "true" });
      expect(res.body.include_info).toBe(true);
      expect(res.body.ef_search).toBeNull();
      expect(res.body.results[0].message).toContain("Health check OK");
   });

   it("sem INFO, o planner usa o índice HNSW parcial", async () => {
      // The partial index is used only if the query's WHERE matches its predicate:
      // this breaks if NOT_INFO and migration 20261118120000 drift apart.
      const plan = await db.transaction(async (trx) => {
         await trx.raw("SET LOCAL enable_seqscan = off"); // a 10k table could tempt a seq scan
         const { rows } = await trx.raw(
            `EXPLAIN SELECT id FROM logs WHERE ${NOT_INFO}
             ORDER BY embedding <=> (SELECT embedding FROM logs LIMIT 1) LIMIT 10`,
         );
         return rows.map((r: any) => r["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("idx_logs_embedding_hnsw_not_info");
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

   it("deixa os modelos INFO de fora por padrão, e include_info=true os traz", async () => {
      const off = await search({ q: "Health check OK", mode: "template" });
      expect(await levels(off.body.results.map((r: any) => r.id))).not.toContain("INFO");
      const on = await search({ q: "Health check OK", mode: "template", include_info: "true" });
      expect(on.body.results[0].message).toContain("Health check OK");
   });

   it("os resultados vêm de vários modelos quando o primeiro tem menos de k logs", async () => {
      const res = await search({ q: "certificate has expired", mode: "template", k: 50 });
      const templates = new Set(res.body.results.map((r: any) => r.template.id));
      expect(res.body.results).toHaveLength(50);
      expect(templates.size).toBeGreaterThan(1);
   });
});
