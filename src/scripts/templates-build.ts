import db from "../db/knex";
import { buildTemplates, embedTemplates } from "../search/templates";

/**
 * Builds log_templates, log_template_variants and log_template_map from the
 * logs table, then embeds the templates that need it.
 *
 * --no-describe leaves the descriptions (data/template-descriptions.json) out
 * of embed_text, to compare with and without them.
 *
 * Usage: pnpm templates:build [--no-embed] [--no-describe]
 */

const fmt = (n: number) => n.toLocaleString("en-US");

async function main() {
   const withDescriptions = !process.argv.includes("--no-describe");
   const b = await buildTemplates(db, { describe: withDescriptions });
   console.log(
      `mined ${fmt(b.logs)} logs into ${fmt(b.templates)} templates (${fmt(b.variants)} distinct normalized messages) ` +
         `in ${(b.ms.mine / 1000).toFixed(1)}s, wrote the tables in ${(b.ms.write / 1000).toFixed(1)}s; ` +
         (withDescriptions
            ? `${fmt(b.described)} with a description${b.described < b.templates ? ` (${fmt(b.templates - b.described)} without: pnpm templates:describe)` : ""}`
            : "descriptions off (--no-describe)"),
   );
   if (process.argv.includes("--no-embed")) return;
   const e = await embedTemplates(db);
   console.log(
      `embedded ${fmt(e.embedded)} templates in ${(e.ms / 1000).toFixed(1)}s` +
         (b.embeddings_kept ? ` (${fmt(b.embeddings_kept)} kept: same text as before)` : ""),
   );
   const { rows } = await db.raw(`
      SELECT pg_size_pretty(pg_total_relation_size('log_templates')) AS templates,
             pg_size_pretty(pg_total_relation_size('log_template_map')) AS map,
             pg_size_pretty(pg_total_relation_size('log_template_variants')) AS variants`);
   console.log(`sizes: log_templates ${rows[0].templates}, log_template_map ${rows[0].map}, log_template_variants ${rows[0].variants}`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
