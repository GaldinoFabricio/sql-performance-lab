/**
 * Second pass after toTemplate: finds the variable parts that regexes can't
 * see (a company or city name, a file name) by comparing templates with each
 * other, in the spirit of Drain (He et al., 2017), the usual log parser.
 *
 *    Throttling tenant Kerluke Group: <num> requests in the last minute (quota <num>)
 *    Throttling tenant Smith, Jones and Brown: <num> requests in the last minute (quota <num>)
 *      → Throttling tenant <*> <num> requests in the last minute (quota <num>)
 *
 * Drain only compares messages with the same number of tokens, so a name of
 * 2 or 4 words would never meet. Here two token lists are aligned by their
 * common prefix and suffix; what is left in the middle is compared position
 * by position when it has the same length, or becomes one <*> when it doesn't.
 *
 * Guards against merging templates that mean different things:
 *  - only templates in the same partition meet: same level and error_code,
 *    so "HTTP_502" and "HTTP_503", or an INFO and an ERROR, never merge;
 *  - they must share the first token;
 *  - templates under MIN_TOKENS never merge: in a short message one word is
 *    often the whole meaning ("Health check OK" / "Health check FAILED");
 *  - at least SIMILARITY of the tokens must be equal, and a variable span
 *    can't be longer than MAX_SPAN tokens.
 * Merges that slip through show up as lower purity in pnpm eval:templates.
 *
 * Online: logs are added one at a time and each gets a cluster id that never
 * changes, while the cluster's text can become more general. The result
 * depends on the order of the logs, as with Drain.
 */

export const WILDCARD = "<*>";
const SIMILARITY = 0.6;
const MIN_TOKENS = 4;
const MAX_SPAN = 5;

export interface Cluster {
   id: number;
   tokens: string[];
   partition: string;
}

/** Common prefix length; a wildcard in the cluster stops it. */
function prefixLen(a: string[], b: string[], max: number) {
   let i = 0;
   while (i < max && a[i] === b[i] && a[i] !== WILDCARD) i++;
   return i;
}

/**
 * Merged tokens and how many tokens matched, or null when the two lists are
 * not the same template.
 */
export function align(cluster: string[], tokens: string[]): { merged: string[]; equal: number } | null {
   if (cluster.length < MIN_TOKENS || tokens.length < MIN_TOKENS) return null;
   const max = Math.min(cluster.length, tokens.length);
   const pre = prefixLen(cluster, tokens, max);
   if (pre === 0) return null;
   const suf = prefixLen([...cluster].reverse(), [...tokens].reverse(), max - pre);
   const midC = cluster.slice(pre, cluster.length - suf);
   const midT = tokens.slice(pre, tokens.length - suf);

   let middle: string[];
   let equal = pre + suf;
   if (midC.length === midT.length) {
      // same length: position by position, each difference becomes a wildcard
      middle = midC.map((t, i) => {
         if (t === midT[i] && t !== WILDCARD) {
            equal++;
            return t;
         }
         return WILDCARD;
      });
      // a run of differences is one variable: collapse "<*> <*>" into "<*>"
      middle = middle.filter((t, i) => !(t === WILDCARD && middle[i - 1] === WILDCARD));
   } else {
      if (midT.length > MAX_SPAN) return null;
      middle = [WILDCARD];
   }
   const longestRun = Math.max(0, ...runs(midC, midT));
   if (longestRun > MAX_SPAN) return null;
   if (equal / Math.max(cluster.length, tokens.length) < SIMILARITY) return null;
   return { merged: [...cluster.slice(0, pre), ...middle, ...cluster.slice(cluster.length - suf)], equal };
}

/** Lengths of the runs of differing tokens in the middle part of the new list. */
function runs(midC: string[], midT: string[]): number[] {
   if (midC.length !== midT.length) return [midT.length];
   const out: number[] = [];
   let run = 0;
   for (let i = 0; i < midT.length; i++) {
      if (midC[i] === midT[i] && midC[i] !== WILDCARD) {
         if (run) out.push(run);
         run = 0;
      } else run++;
   }
   if (run) out.push(run);
   return out;
}

export class TemplateMiner {
   private clusters: Cluster[] = [];
   // partition + first token → clusters that can still meet a new template
   private buckets = new Map<string, Cluster[]>();
   // most logs repeat an earlier template exactly: skip the comparison for them
   private seen = new Map<string, Cluster>();

   /** Returns the cluster the template belongs to (created or generalized). */
   add(template: string, partition = ""): Cluster {
      const exact = this.seen.get(`${partition}\u0000${template}`);
      if (exact) return exact;

      const tokens = template.split(" ");
      const key = `${partition}\u0000${tokens[0]}`;
      const bucket = this.buckets.get(key) ?? this.buckets.set(key, []).get(key)!;
      let best: { cluster: Cluster; merged: string[]; score: number } | null = null;
      for (const cluster of bucket) {
         const a = align(cluster.tokens, tokens);
         if (!a) continue;
         const score = a.equal / Math.max(cluster.tokens.length, tokens.length);
         if (!best || score > best.score) best = { cluster, merged: a.merged, score };
      }

      let cluster: Cluster;
      if (best) {
         cluster = best.cluster;
         cluster.tokens = best.merged;
      } else {
         cluster = { id: this.clusters.length, tokens, partition };
         this.clusters.push(cluster);
         bucket.push(cluster);
      }
      this.seen.set(`${partition}\u0000${template}`, cluster);
      return cluster;
   }

   get all(): readonly Cluster[] {
      return this.clusters;
   }
}

export const clusterText = (c: Cluster) => c.tokens.join(" ");
