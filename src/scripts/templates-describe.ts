import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import db from "../db/knex";
import { DESCRIPTIONS_PATH, TemplateDescriptions, descriptionKey } from "../logs/descriptions";

/**
 * Writes a plain-English description of every log template to
 * data/template-descriptions.json, with an LLM (`claude -p`, the Claude
 * Code CLI), once, offline. Search never calls the LLM: the descriptions are
 * data, committed and reviewed like code, and the search stays fast and
 * repeatable ("document expansion").
 *
 * Why: the embedding model and the reranker only know the words in a log.
 * "Unable to resolve hostname" is a DNS failure, but nothing in the text says
 * "DNS" or "address", so a search for "cannot find the address of the payment
 * server" never reaches it. A description written by a model that knows the
 * domain adds those words.
 *
 * The LLM sees ONLY the template text and one real example. Never the
 * root_cause labels or the eval queries: either would make the eval measure
 * the labels instead of the search.
 *
 * Keeps descriptions already in the file (by partition + template text) and
 * only asks for the missing ones, so a rebuild with new templates is cheap.
 *
 * Usage: pnpm templates:describe [--all]   (--all rewrites every description)
 */

const BATCH = 17;

const prompt = (items: { n: number; level: string; code: string; template: string; example: string }[]) => `You are helping build a log search for on-call engineers.
Below are log message templates from a backend (Node.js / Postgres / Redis / Kafka / payment providers). In a template, <*>, <id>, <num>, <ip>, <host> and similar mark values that change between log lines.

For each template write ONE description (20 to 35 words) in plain English that says what went wrong (or what happened, for normal logs) and its likely impact, in the words an engineer would use when searching for it. Mention the common names of the problem and of the system involved (for example the protocol, the component, the kind of error), including words that are NOT in the log itself. Do not repeat ids, numbers or host names. Do not guess a specific cause that the log doesn't support.

${items.map((x) => `${x.n}. [${x.level}${x.code ? ` ${x.code}` : ""}] ${x.template}\n   example: ${x.example.split("\n")[0].slice(0, 200)}`).join("\n")}

Reply with ONLY a JSON array, one object per template, in the same order: [{"n": 1, "description": "..."}, ...]`;

async function main() {
   const all = process.argv.includes("--all");
   const file: TemplateDescriptions = existsSync(DESCRIPTIONS_PATH) && !all
      ? JSON.parse(readFileSync(DESCRIPTIONS_PATH, "utf8"))
      : { generated_by: "", note: "", descriptions: {} };

   const { rows } = await db.raw("SELECT partition, template, example FROM log_templates ORDER BY partition, id");
   if (rows.length === 0) throw new Error("no templates: run pnpm templates:build first");
   const missing = rows.filter((r: any) => !file.descriptions[descriptionKey(r.partition, r.template)]);
   console.log(`${rows.length} templates, ${rows.length - missing.length} already described, asking for ${missing.length}`);

   const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
   for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH).map((r: any, j: number) => {
         const [level, code] = r.partition.split("|");
         return { n: j + 1, level, code, template: r.template, example: r.example, key: descriptionKey(r.partition, r.template) };
      });
      const out = execFileSync("claude", ["-p", prompt(batch)], { encoding: "utf8", timeout: 300_000 });
      const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
      const answers: { n: number; description: string }[] = JSON.parse(json);
      for (const b of batch) {
         const a = answers.find((x) => x.n === b.n);
         if (!a?.description) throw new Error(`no description for template ${b.n}: ${b.template}`);
         file.descriptions[b.key] = a.description.trim();
      }
      console.log(`  described ${Math.min(i + BATCH, missing.length)}/${missing.length}`);
   }

   file.generated_by = `claude -p (Claude Code ${version}), pnpm templates:describe`;
   file.note =
      "One plain-English description per log template, keyed by 'partition<TAB>template'. Written by an LLM that saw only the " +
      "template and one example, never root_cause labels or eval queries. Review before committing; edit by hand if needed.";
   file.descriptions = Object.fromEntries(Object.entries(file.descriptions).sort(([a], [b]) => a.localeCompare(b)));
   writeFileSync(DESCRIPTIONS_PATH, JSON.stringify(file, null, 2) + "\n");
   console.log(`wrote ${DESCRIPTIONS_PATH}`);
}

main()
   .catch((err) => {
      console.error(err);
      process.exitCode = 1;
   })
   .finally(() => db.destroy());
