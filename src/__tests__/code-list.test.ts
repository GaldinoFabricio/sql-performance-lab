import { describe, it, expect, afterAll } from "vitest";
import db from "../db/knex";
import { EMBEDDING_DIM } from "../embeddings/model";
import { hybridSearch } from "../search/search";

afterAll(async () => {
   await db.destroy();
});

// The code list reads the newest `candidates` logs per code, then must keep
// every code represented. Rolled back at the end: no data is left behind.
describe("hybridSearch: code list with several codes", () => {
   it("a noisy code can't take every slot of the code list", async () => {
      const zero = `[${new Array(EMBEDDING_DIM).fill(0).join(",")}]`;
      const trx = await db.transaction();
      try {
         await trx.raw("DELETE FROM logs");
         // 40P01 is the oldest log; 50 newer ECONNRESET logs follow.
         await trx("logs").insert({ service: "db", level: "ERROR", error_code: "40P01", message: "x" });
         await trx.raw(
            `INSERT INTO logs (service, level, error_code, message)
             SELECT 'api', 'ERROR', 'ECONNRESET', 'y' FROM generate_series(1, 50)`,
         );
         const hits = await hybridSearch(trx, "x", zero, 10, null, {
            candidates: 10,
            vectorWeight: 0,
            keywordWeight: 0,
            codes: ["ECONNRESET", "40P01"],
            codeWeight: 1,
         });
         const { rows } = await trx.raw("SELECT id FROM logs WHERE error_code = '40P01'");
         const ids = hits.map((h) => h.id);
         expect(ids).toContain(Number(rows[0].id));
         // the newest log of the noisy code still ranks first
         const { rows: [newest] } = await trx.raw("SELECT max(id) AS id FROM logs WHERE error_code = 'ECONNRESET'");
         expect(ids[0]).toBe(Number(newest.id));
      } finally {
         await trx.rollback();
      }
   });
});
