import { WILDCARD } from "./miner";

/**
 * What each <*> of a mined template stands for, and the text to embed.
 *
 * The miner replaces a varying part with <*>, which can swallow meaning:
 * "Rate limit hit when calling <*> API" lost the partner name, so a search
 * for "stripe rate limit" can't see it in the template's vector. A wildcard
 * with few distinct values is a category (a partner, a table, a route), and
 * its values go back into the embedded text; one with many values (company
 * names, file names) is an identifier and stays <*>.
 */

/** A wildcard with at most this many distinct values is a category. */
export const MAX_CATEGORY_VALUES = 10;
/** How many values of a category go into the embedded text. */
const VALUES_IN_TEXT = 5;

export interface WildcardValues {
   distinct: number;
   /** Most frequent first, with how many logs had each value (capped at 20). */
   top: { value: string; logs: number }[];
}

/** Regex that matches a variant against its template, one group per <*>. */
function matcher(template: string): RegExp {
   const parts = template.split(" ").map((t) => (t === WILDCARD ? "(.+?)" : t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
   return new RegExp(`^${parts.join(" ")}$`);
}

/**
 * Values per wildcard, from the variants (normalized messages) the template
 * absorbed and how many logs each had.
 */
export function wildcardValues(template: string, variants: { variant: string; logs: number }[]): WildcardValues[] {
   const n = template.split(" ").filter((t) => t === WILDCARD).length;
   const counts = Array.from({ length: n }, () => new Map<string, number>());
   const re = matcher(template);
   for (const { variant, logs } of variants) {
      const m = re.exec(variant);
      if (!m) continue;
      for (let i = 0; i < n; i++) counts[i].set(m[i + 1], (counts[i].get(m[i + 1]) ?? 0) + logs);
   }
   return counts.map((c) => ({
      distinct: c.size,
      top: [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([value, logs]) => ({ value, logs })),
   }));
}

/** The template with each category wildcard replaced by its values: "calling stripe / adyen / fedex API". */
export function embedText(template: string, values: WildcardValues[]): string {
   let i = 0;
   return template
      .split(" ")
      .map((t) => {
         if (t !== WILDCARD) return t;
         const v = values[i++];
         return v && v.distinct > 0 && v.distinct <= MAX_CATEGORY_VALUES ? v.top.slice(0, VALUES_IN_TEXT).map((x) => x.value).join(" / ") : t;
      })
      .join(" ");
}
