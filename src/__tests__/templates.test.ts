import { existsSync } from "fs";
import path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import db from "../db/knex";
import { modelDir } from "../embeddings/model";
import { buildTemplates, embedTemplates } from "../search/templates";

// Needs seeded logs (and the model for the embedding test); skipped otherwise,
// like the search tests.
const hasModel = existsSync(path.join(modelDir(), "onnx/model_quantized.onnx"));
await db.migrate.latest();
const { rows: [{ n }] } = await db.raw("SELECT count(*)::int AS n FROM logs");
const ready = n > 0;
if (!ready) console.warn("template tests skipped: run pnpm seed:logs");

afterAll(async () => {
   await db.destroy();
});

describe.skipIf(!ready)("templates:build", () => {
   let stats: Awaited<ReturnType<typeof buildTemplates>>;
   beforeAll(async () => {
      stats = await buildTemplates(db);
   });

   it("puts every log in exactly one template", async () => {
      const { rows: [r] } = await db.raw(`
         SELECT (SELECT count(*) FROM logs)::int AS logs,
                (SELECT count(*) FROM log_template_map)::int AS mapped,
                (SELECT sum(log_count) FROM log_templates)::int AS counted,
                (SELECT sum(log_count) FROM log_template_variants)::int AS in_variants`);
      expect(r).toEqual({ logs: n, mapped: n, counted: n, in_variants: n });
      expect(stats.logs).toBe(n);
   });

   it("no template mixes root causes (root_cause is read only by this check)", async () => {
      const { rows } = await db.raw(`
         SELECT m.template_id FROM log_template_map m JOIN logs l ON l.id = m.log_id
         GROUP BY m.template_id HAVING count(DISTINCT l.root_cause) > 1`);
      expect(rows).toEqual([]);
   });

   it("far fewer templates than logs", () => {
      expect(stats.templates).toBeLessThan(100);
   });

   it("a category wildcard gets its values back in embed_text", async () => {
      const { rows } = await db.raw("SELECT template, embed_text FROM log_templates WHERE template LIKE 'Rate limit hit when calling%'");
      expect(rows).toHaveLength(1);
      expect(rows[0].template).toContain("calling <*> API");
      expect(rows[0].embed_text).toMatch(/calling .*stripe.* API/);
   });

   it("is deterministic: a rebuild gives the same templates", async () => {
      const before = (await db.raw("SELECT id, template FROM log_templates ORDER BY id")).rows;
      await buildTemplates(db);
      expect((await db.raw("SELECT id, template FROM log_templates ORDER BY id")).rows).toEqual(before);
   });

   it.skipIf(!hasModel)("embeds only what changed", async () => {
      await embedTemplates(db);
      const { rows: [r] } = await db.raw("SELECT count(*)::int AS missing FROM log_templates WHERE embedding IS NULL");
      expect(r.missing).toBe(0);

      const again = await buildTemplates(db);
      expect(again.embeddings_kept).toBe(again.templates);
      expect((await embedTemplates(db)).embedded).toBe(0);
   });
});
