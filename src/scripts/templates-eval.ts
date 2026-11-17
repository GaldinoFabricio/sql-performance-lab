import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { generateLogs, TEMPLATE_KEYS } from "../logs/generator";
import { TemplateMiner, clusterText } from "../logs/miner";
import { toTemplate } from "../logs/template";

/**
 * How good are the templates? Phase 1.1 of "one embedding per template".
 * Two stages are measured on the same logs:
 *   regex: toTemplate alone (src/logs/template.ts);
 *   mined: toTemplate, then TemplateMiner (src/logs/miner.ts), which also
 *          finds variables regexes can't see, such as names.
 *
 * Runs the log generator in memory (same seed as pnpm seed:logs, no database)
 * and compares the templates toTemplate finds with the generator's own:
 *
 *  - templates: how many toTemplate finds, against the generator's 67.
 *  - purity by root_cause: share of logs whose template belongs, by majority,
 *    to the same root_cause. This is what search needs: a template that mixes
 *    two root causes would send a query to the wrong logs. Goal >= 95%.
 *  - purity by generator template: same, against template_key. Lower is not
 *    always bad: two phrasings of the same root cause merged is harmless.
 *  - fragmentation: templates found per generator template. 1 is ideal; a
 *    variable the regexes can't see (a company name) gives one per value.
 *  - growth: new templates in the last 10% of rows. If templates keep
 *    appearing at the same rate, one-embedding-per-template saves little.
 *
 * The first N rows of a run of M rows are the same logs as a run of N rows
 * (each row draws the same random numbers; only created_at is spread
 * differently), so one pass over the largest size measures every size.
 *
 * Usage: pnpm eval:templates [--rows=10000,100000,1000000] [--seed=42]
 */

const ROOT = path.resolve(__dirname, "../..");
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const sizes = (flag("rows") ?? "10000,100000,1000000").split(",").map(Number).sort((a, b) => a - b);
const seed = Number(flag("seed") ?? 42);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const label = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}m` : `${n / 1000}k`);

interface Stats {
   count: number;
   causes: Map<string, number>;
   keys: Map<string, number>;
   example: string;
}

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const majority = (m: Map<string, number>) => Math.max(...m.values());

function report(
   stage: string,
   n: number,
   templates: Map<string, Stats>,
   firstSeen: Map<string, number>,
   text: (key: string) => string = (k) => k,
) {
   const all = [...templates.values()];
   const causePure = all.reduce((a, s) => a + majority(s.causes), 0) / n;
   const keyPure = all.reduce((a, s) => a + majority(s.keys), 0) / n;
   const impure = [...templates]
      .filter(([, s]) => s.causes.size > 1)
      .sort((a, b) => b[1].count - majority(b[1].causes) - (a[1].count - majority(a[1].causes)))
      .map(([t, s]) => ({ template: text(t), logs: s.count, root_causes: Object.fromEntries(s.causes) }));

   // fragmentation: how many found templates each generator template was split into
   const perKey = new Map<string, Set<string>>();
   for (const [t, s] of templates) for (const k of s.keys.keys()) (perKey.get(k) ?? perKey.set(k, new Set()).get(k)!).add(t);
   const frag = [...perKey]
      .map(([key, set]) => ({ key, templates: set.size, examples: [...set].slice(0, 3).map(text) }))
      .sort((a, b) => b.templates - a.templates);
   const tail = [...firstSeen.values()].filter((i) => i >= n * 0.9).length;

   console.log(`\n${label(n)} rows, ${stage}: ${templates.size.toLocaleString()} templates (generator: ${new Set([...perKey.keys()]).size} of ${TEMPLATE_KEYS.length} seen)`);
   console.log(`   purity by root_cause      ${pct(causePure)}   (${impure.length} templates mix root causes)`);
   console.log(`   purity by generator tpl   ${pct(keyPure)}`);
   console.log(`   new templates in the last 10% of rows: ${tail.toLocaleString()} (${(tail / (n * 0.1) * 1000).toFixed(1)} per 1,000 logs)`);
   const split = frag.filter((f) => f.templates > 1);
   console.log(`   generator templates split in more than one: ${split.length} of ${frag.length}; worst:`);
   for (const f of split.slice(0, 6)) console.log(`      ${String(f.templates).padStart(6)}  ${f.key.padEnd(24)} e.g. ${f.examples[0].slice(0, 80)}`);
   for (const i of impure.slice(0, 3)) console.log(`   mixes root causes: ${i.template.slice(0, 70)} ${JSON.stringify(i.root_causes)}`);

   return {
      stage,
      rows: n,
      templates: templates.size,
      generator_templates_seen: perKey.size,
      purity_root_cause: causePure,
      purity_generator_template: keyPure,
      impure_templates: impure.slice(0, 20),
      new_templates_last_10pct: tail,
      fragmentation: frag.map(({ key, templates: t, examples }) => ({ key, templates: t, examples })),
   };
}

function track(stats: Map<string, Stats>, firstSeen: Map<string, number>, key: string, i: number, log: { message: string; root_cause: string; template_key: string }) {
   let s = stats.get(key);
   if (!s) {
      s = { count: 0, causes: new Map(), keys: new Map(), example: log.message };
      stats.set(key, s);
      firstSeen.set(key, i);
   }
   s.count++;
   inc(s.causes, log.root_cause);
   inc(s.keys, log.template_key);
}

function main() {
   const max = sizes[sizes.length - 1];
   const regex = { stats: new Map<string, Stats>(), firstSeen: new Map<string, number>() };
   const mined = { stats: new Map<string, Stats>(), firstSeen: new Map<string, number>() };
   const miner = new TemplateMiner();
   const results = [];
   const t0 = performance.now();
   let i = 0;
   for (const log of generateLogs({ count: max, seed })) {
      const t = toTemplate(log.message);
      track(regex.stats, regex.firstSeen, t, i, log);
      // only templates with the same level and error_code may merge (see miner.ts)
      const cluster = miner.add(t, `${log.level}|${log.error_code ?? ""}`);
      track(mined.stats, mined.firstSeen, String(cluster.id), i, log);
      i++;
      if (sizes.includes(i)) {
         results.push(report("regex", i, regex.stats, regex.firstSeen));
         results.push(report("mined", i, mined.stats, mined.firstSeen, (id) => clusterText(miner.all[Number(id)])));
      }
   }
   console.log(`\n${max.toLocaleString()} logs normalized and mined in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

   const out = flag("out") ? path.resolve(ROOT, flag("out")!) : path.join(ROOT, "evals/results/templates.json");
   mkdirSync(path.dirname(out), { recursive: true });
   writeFileSync(out, JSON.stringify({ created_at: new Date().toISOString(), seed, generator_templates: TEMPLATE_KEYS.length, sizes: results }, null, 2));
   console.log(`wrote ${path.relative(ROOT, out)}`);
}

main();
