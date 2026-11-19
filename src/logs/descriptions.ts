import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * Plain-English descriptions of the log templates, written once by an LLM
 * (pnpm templates:describe) and committed. See that script for why and how.
 */

// Repo root, so it resolves the same from src/logs (ts-node) and dist/logs (node dist/server.js).
export const DESCRIPTIONS_PATH = path.resolve(__dirname, "../../data/template-descriptions.json");

export interface TemplateDescriptions {
   generated_by: string;
   note: string;
   /** 'partition<TAB>template' -> description */
   descriptions: Record<string, string>;
}

export const descriptionKey = (partition: string, template: string) => `${partition}\t${template}`;

let cache: Record<string, string> | null = null;

/** The description of a template, or null when it has none (a new template, or no file). */
export function describe(partition: string, template: string): string | null {
   cache ??= existsSync(DESCRIPTIONS_PATH)
      ? (JSON.parse(readFileSync(DESCRIPTIONS_PATH, "utf8")) as TemplateDescriptions).descriptions
      : {};
   return cache[descriptionKey(partition, template)] ?? null;
}
