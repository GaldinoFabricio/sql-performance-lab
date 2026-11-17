/**
 * Log message → template: the message with its variable parts replaced by
 * placeholders, so the thousands of logs printed by the same line of code
 * collapse into one string.
 *
 *    Redis connection lost (ECONNRESET), reconnecting in 1126ms
 *    Redis connection lost (ECONNRESET), reconnecting in 4410ms
 *      → Redis connection lost (ECONNRESET), reconnecting in <num>ms
 *
 * Why: most logs are copies of a few templates (the generator has 67). One
 * embedding per template instead of one per log means far fewer vectors to
 * search, few enough for exact search, and new logs only need an embedding
 * when their template is new.
 *
 * Only the shape of each token is used (regexes, no learning), so it is
 * predictable and easy to test, but it cannot recognize free-text variables
 * such as a company or city name. `pnpm eval:templates` measures how well it
 * does against the generator's own templates.
 */

// Order matters: specific shapes first, so "10.1.2.3" becomes <ip> before its
// digits could become <num>, and an email before its domain looks like a host.
const RULES: [RegExp, string | ((m: string) => string)][] = [
   // 3f2a9c1e-...-...: request ids
   [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
   // 2026-11-14T03:12:45.123Z, 2026-11-14
   [/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, "<time>"],
   [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>"],
   [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>"],
   // api.stripe.com, redis-sessions.internal; not java.lang.NullPointerException
   [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com\.br|com|internal|local|io|net|org)\b/gi, "<host>"],
   // prefixed ids: ord_9xvizahxgg, usr_48213, ch_AbCdEfGhIjKlMn, SKU-K3J9QZ. A random
   // suffix may have no digit by chance, so a long one (8+) counts as an id too.
   [
      /\b[A-Za-z]{2,4}[_-][A-Za-z0-9]{4,}\b/g,
      (m) => {
         const rest = m.slice(m.search(/[_-]/) + 1);
         return /\d/.test(rest) || rest.length >= 8 || (/^[A-Z0-9]+$/.test(rest) && rest.length >= 6) ? "<id>" : m;
      },
   ],
   // random tokens with letters and digits: container ids (k3j2h1ab);
   // a number with a unit (1126ms, 512Mi) is left for the <num> rule
   [/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi, (m) => (/^\d+[a-z]{1,3}$/i.test(m) ? m : "<id>")],
   // numbers, also glued to a unit (227ms, 1024Mi); not inside a word (x509)
   [/(?<![A-Za-z0-9_<])-?\d+(?:\.\d+)?/g, "<num>"],
];

export function toTemplate(message: string): string {
   // The first line names the error; stack frames vary run to run and say little.
   let t = message.split("\n", 1)[0].trim();
   for (const [re, to] of RULES) t = typeof to === "string" ? t.replace(re, to) : t.replace(re, to);
   return t.replace(/\s+/g, " ");
}
