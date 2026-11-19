import { existsSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { modelDir, RERANKER_MODEL } from "../embeddings/model";
import { orderByScore, RERANK_BATCH, rerankText, scorePairs } from "../search/rerank";

describe("orderByScore", () => {
   it("ordena pela nota, maior primeiro, e corta em k", () => {
      const out = orderByScore([{ id: 1 }, { id: 2 }, { id: 3 }], [0.1, 3, -2], 2);
      expect(out.map((h) => h.id)).toEqual([2, 1]);
      expect(out[0].rerank_score).toBe(3);
   });

   it("em empate mantém a ordem da primeira busca", () => {
      const out = orderByScore([{ id: 7 }, { id: 5 }, { id: 9 }], [1, 2, 1], 3);
      expect(out.map((h) => h.id)).toEqual([5, 7, 9]);
   });
});

// ~91 MB and gitignored, like the embedding model: skipped without `pnpm model:fetch`.
const hasModel = existsSync(path.join(modelDir(RERANKER_MODEL), "onnx/model.onnx"));
if (!hasModel) console.warn("reranker tests skipped: run `pnpm model:fetch`");

describe.skipIf(!hasModel)("scorePairs", () => {
   const logs = [
      "Redis connection lost: connect ECONNREFUSED 10.0.3.7:6379",
      "GET /api/orders 200 34ms",
      "TypeError: Cannot read properties of undefined (reading 'id')\n    at OrderService.create (/app/src/services/order.service.ts:42:17)\n    at Router.handle (/app/node_modules/express/lib/router/index.js:284:9)",
      "TokenExpiredError: jwt expired at 2026-11-10T10:00:00Z",
      "Deadlock detected while updating inventory rows",
   ];

   it("o log sobre o problema da consulta recebe a maior nota", async () => {
      const scores = await scorePairs("redis is down", logs);
      expect(scores).toHaveLength(logs.length);
      expect(scores.indexOf(Math.max(...scores))).toBe(0);
   });

   it("a nota de um par não depende do lote nem da ordem", async () => {
      expect(logs.length).toBeGreaterThan(RERANK_BATCH); // more than one batch
      const all = await scorePairs("session expired", logs);
      const reversed = await scorePairs("session expired", [...logs].reverse());
      for (const [i, text] of logs.entries()) {
         const [alone] = await scorePairs("session expired", [text]);
         expect(alone).toBe(all[i]);
         expect(reversed[logs.length - 1 - i]).toBe(all[i]);
      }
   });

   it("textos repetidos recebem a mesma nota de quando vão sozinhos", async () => {
      const [a, b, c] = await scorePairs("redis is down", [logs[0], logs[1], logs[0]]);
      const [alone] = await scorePairs("redis is down", [logs[0]]);
      expect(a).toBe(alone);
      expect(c).toBe(alone);
      expect(b).not.toBe(alone);
   });

   it("lista vazia não carrega o modelo à toa", async () => {
      expect(await scorePairs("anything", [])).toEqual([]);
   });
});

describe("rerankText", () => {
   const log = { message: "Unable to resolve hostname api.stripe.com while calling fedex", error_code: "ENOTFOUND", partition: "ERROR|ENOTFOUND", template: "Unable to resolve hostname <host> while calling <*>" };

   it("message: só a mensagem", () => {
      expect(rerankText(log, "message")).toBe(log.message);
   });

   it("code: põe o código na frente quando a mensagem não o contém", () => {
      expect(rerankText(log, "code")).toBe(`ENOTFOUND: ${log.message}`);
      expect(rerankText({ message: "connect ECONNREFUSED 10.0.0.1:5432", error_code: "ECONNREFUSED" }, "code")).toBe("connect ECONNREFUSED 10.0.0.1:5432");
   });

   it("described/template: sem template conhecido, cai no texto de code", () => {
      expect(rerankText({ ...log, partition: "X|Y", template: "nada parecido" }, "described")).toBe(`ENOTFOUND: ${log.message}`);
      expect(rerankText({ ...log, template: null }, "template")).toBe(`ENOTFOUND: ${log.message}`);
   });
});
