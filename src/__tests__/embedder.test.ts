import { existsSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { cosineSimilarity, embed, EMBEDDING_DIM, toPgVector } from "../embeddings/embedder";
import { modelDir } from "../embeddings/model";

// The model is ~23 MB and gitignored. CI runs `pnpm model:fetch` first;
// locally, without it, these tests are skipped instead of failing.
const hasModel = existsSync(path.join(modelDir(), "onnx/model_quantized.onnx"));
if (!hasModel) console.warn("embedder tests skipped: run `pnpm model:fetch`");

describe.skipIf(!hasModel)("embed", () => {
   it("retorna vetores de 384 dimensões normalizados", async () => {
      const [v] = await embed(["Health check OK"]);
      expect(v.length).toBe(EMBEDDING_DIM);
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
   });

   it("é determinístico e não depende dos vizinhos no lote", async () => {
      const text = "connect ECONNREFUSED 10.0.0.9:5432";
      const [alone] = await embed([text]);
      const [, inBatch] = await embed([
         "Health check OK",
         text,
         "TypeError: Cannot read properties of undefined (reading 'id')\n    at OrderService.create (/app/src/services/order.service.ts:42:17)",
      ]);
      expect(Array.from(inBatch)).toEqual(Array.from(alone));
   });

   it("o mesmo problema com palavras diferentes fica mais perto que um problema diferente", async () => {
      const [jwt, sameProblem, otherProblem] = await embed([
         "TokenExpiredError: jwt expired at 2026-11-10T10:00:00Z",
         "Bearer token rejected: exp claim is in the past (user usr_9)",
         "connect ECONNREFUSED 10.0.0.9:5432",
      ]);
      expect(cosineSimilarity(jwt, sameProblem)).toBeGreaterThan(
         cosineSimilarity(jwt, otherProblem),
      );

      const [pay502, pay503, health] = await embed([
         "Payment provider responded 502 Bad Gateway for charge ch_abc",
         "Stripe API request failed: upstream returned 503 Service Unavailable",
         "Health check OK",
      ]);
      expect(cosineSimilarity(pay502, pay503)).toBeGreaterThan(
         cosineSimilarity(pay502, health),
      );
   });
});

describe("toPgVector", () => {
   it("formata no formato texto do pgvector", () => {
      expect(toPgVector([0.5, -1, 2])).toBe("[0.5,-1,2]");
   });
});
