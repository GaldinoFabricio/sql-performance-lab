import type { Knex } from "knex";
import { embed, toPgVector } from "../embeddings/embedder";
import { TemplateMiner, clusterText } from "../logs/miner";
import { toTemplate } from "../logs/template";
import { embedText, wildcardValues } from "../logs/values";

/**
 * Builds the template tables (migration 20261117120000_create_log_templates.ts)
 * from the logs table: every log goes through toTemplate and TemplateMiner,
 * in id order so the result is deterministic.
 *
 * A full rebuild, in one transaction: readers see the old templates or the
 * new ones, never half. Embeddings whose embed_text did not change are kept,
 * so a rebuild only re-embeds templates whose text moved.
 */

const READ_BATCH = 10_000;
const WRITE_BATCH = 5_000; // 2–4 params per row, well below Postgres' 65,535

export interface BuildStats {
   logs: number;
   templates: number;
   variants: number;
   embeddings_kept: number;
   ms: { mine: number; write: number };
}

const partitionOf = (level: string, errorCode: string | null) => `${level}|${errorCode ?? ""}`;

async function insertBatches(trx: Knex.Transaction, table: string, rows: object[]) {
   for (let i = 0; i < rows.length; i += WRITE_BATCH) await trx(table).insert(rows.slice(i, i + WRITE_BATCH));
}

export async function buildTemplates(db: Knex): Promise<BuildStats> {
   const t0 = performance.now();
   const miner = new TemplateMiner();
   const map: { log_id: number; template_id: number }[] = [];
   const variants = new Map<string, { partition: string; variant: string; template_id: number; log_count: number }>();
   const perTemplate = new Map<number, { log_count: number; last_log_id: number; example: string }>();

   for (let last = 0; ; ) {
      const { rows } = await db.raw(
         "SELECT id, level, error_code, message FROM logs WHERE id > ? ORDER BY id LIMIT ?",
         [last, READ_BATCH],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
         const id = Number(r.id);
         const partition = partitionOf(r.level, r.error_code);
         const variant = toTemplate(r.message);
         const cluster = miner.add(variant, partition);
         map.push({ log_id: id, template_id: cluster.id });

         const key = `${partition}\u0000${variant}`;
         const v = variants.get(key) ?? variants.set(key, { partition, variant, template_id: cluster.id, log_count: 0 }).get(key)!;
         v.log_count++;
         const t = perTemplate.get(cluster.id) ?? perTemplate.set(cluster.id, { log_count: 0, last_log_id: 0, example: "" }).get(cluster.id)!;
         t.log_count++;
         t.last_log_id = id; // ids grow, so the last one seen is the newest
         t.example = r.message;
      }
      last = Number(rows[rows.length - 1].id);
   }
   const mineMs = performance.now() - t0;

   // Template rows, with the values each <*> stands for.
   const variantsOf = new Map<number, { variant: string; logs: number }[]>();
   for (const v of variants.values()) {
      (variantsOf.get(v.template_id) ?? variantsOf.set(v.template_id, []).get(v.template_id)!).push({ variant: v.variant, logs: v.log_count });
   }
   const templates = miner.all.map((c) => {
      const template = clusterText(c);
      const wildcards = wildcardValues(template, variantsOf.get(c.id) ?? []);
      const stats = perTemplate.get(c.id)!;
      return {
         id: c.id,
         partition: c.partition,
         template,
         embed_text: embedText(template, wildcards),
         log_count: stats.log_count,
         last_log_id: stats.last_log_id,
         example: stats.example,
         wildcards: JSON.stringify(wildcards),
      };
   });

   const t1 = performance.now();
   let kept = 0;
   await db.transaction(async (trx) => {
      // Reuse embeddings by text: the model is deterministic per text.
      const { rows: old } = await trx.raw(
         "SELECT embedded_text, embedding::text AS embedding FROM log_templates WHERE embedding IS NOT NULL",
      );
      const byText = new Map<string, string>(old.map((r: any) => [r.embedded_text, r.embedding]));
      await trx.raw("TRUNCATE log_template_map, log_template_variants, log_templates");
      await insertBatches(
         trx,
         "log_templates",
         templates.map((t) => {
            const embedding = byText.get(t.embed_text);
            if (embedding) kept++;
            return { ...t, embedding: embedding ?? null, embedded_text: embedding ? t.embed_text : null };
         }),
      );
      await insertBatches(trx, "log_template_variants", [...variants.values()]);
      await insertBatches(trx, "log_template_map", map);
   });
   await db.raw("ANALYZE log_templates, log_template_variants, log_template_map");

   return {
      logs: map.length,
      templates: templates.length,
      variants: variants.size,
      embeddings_kept: kept,
      ms: { mine: Math.round(mineMs), write: Math.round(performance.now() - t1) },
   };
}

/**
 * Embeds every template whose embedding is missing or was made from an older
 * embed_text. Resumable like embed:logs: the checkpoint is the data itself.
 */
export async function embedTemplates(db: Knex): Promise<{ embedded: number; ms: number }> {
   const t0 = performance.now();
   const { rows } = await db.raw(
      "SELECT id, embed_text FROM log_templates WHERE embedded_text IS DISTINCT FROM embed_text ORDER BY id",
   );
   for (const r of rows) {
      const [vec] = await embed([r.embed_text]);
      await db.raw("UPDATE log_templates SET embedding = ?::vector, embedded_text = ? WHERE id = ?", [
         toPgVector(vec),
         r.embed_text,
         r.id,
      ]);
   }
   return { embedded: rows.length, ms: Math.round(performance.now() - t0) };
}

export interface TemplateHit {
   id: number;
   root_cause: string | null;
   template: { id: number; text: string; log_count: number; distance: number };
}

/**
 * Search by template: exact cosine distance to every template's embedding
 * (a few dozen rows, so no index), then the newest logs of the nearest
 * templates, nearest template first, until k logs.
 *
 * Exact on purpose: with ~70 vectors a full scan is cheaper than any index
 * and has recall 100% by definition, which is the point of the phase.
 * Logs inserted after the last templates:build are not in log_template_map
 * yet, so they can't be found this way until the next build.
 */
export async function templateSearch(
   db: Knex | Knex.Transaction,
   embedding: string,
   k: number,
   excludeId: number | null = null, // evals: a log used as the query must not find itself
): Promise<TemplateHit[]> {
   const limit = excludeId === null ? k : k + 1;
   const { rows } = await db.raw(
      `WITH nearest AS (
          SELECT id, template, log_count, embedding <=> :vec::vector AS distance
          FROM log_templates
          WHERE embedding IS NOT NULL
          ORDER BY distance, id
          LIMIT :limit
       )
       SELECT l.id, l.root_cause, t.id AS template_id, t.template, t.log_count, t.distance
       FROM nearest t
       CROSS JOIN LATERAL (
          SELECT log_id FROM log_template_map m
          WHERE m.template_id = t.id
          ORDER BY log_id DESC
          LIMIT :limit
       ) m
       JOIN logs l ON l.id = m.log_id
       ORDER BY t.distance, t.id, m.log_id DESC
       LIMIT :limit`,
      { vec: embedding, limit },
   );
   const hits: TemplateHit[] = rows.map((r: any) => ({
      id: Number(r.id),
      root_cause: r.root_cause,
      template: { id: r.template_id, text: r.template, log_count: r.log_count, distance: Number(r.distance) },
   }));
   return hits.filter((h) => h.id !== excludeId).slice(0, k);
}

/**
 * Whether log_template_map covers exactly the logs table (same count and
 * newest id): templates:build ran after the last seed or insert.
 */
export async function templatesCurrent(db: Knex | Knex.Transaction): Promise<boolean> {
   const { rows: [r] } = await db.raw(`
      SELECT (SELECT count(*) FROM logs) = (SELECT count(*) FROM log_template_map)
         AND (SELECT max(id) FROM logs) IS NOT DISTINCT FROM (SELECT max(log_id) FROM log_template_map)
         AND NOT EXISTS (SELECT 1 FROM log_templates WHERE embedded_text IS DISTINCT FROM embed_text) AS ok`);
   return r.ok;
}

/** Whether template search can run: templates built and embedded. */
export async function templatesReady(db: Knex | Knex.Transaction): Promise<boolean> {
   const { rows } = await db.raw("SELECT EXISTS (SELECT 1 FROM log_templates WHERE embedding IS NOT NULL) AS ok");
   return rows[0].ok;
}
