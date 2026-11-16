import { celebrate, Joi, Segments } from "celebrate";
import { SEARCH_DEFAULTS, SEARCH_MODES, SearchMode } from "../services/search.service";

// Integer query param: "" or missing falls back to the default, anything else must be in [min, max].
const intParam = (name: string, min: number, max: number, fallback: number) => {
   const message = `${name} must be an integer between ${min} and ${max}`;
   return Joi.number().integer().min(min).max(max).empty("").default(fallback).messages({
      "number.base": message,
      "number.integer": message,
      "number.min": message,
      "number.max": message,
   });
};

const [efMin, efMax] = SEARCH_DEFAULTS.efSearchRange;

// GET /search/logs. celebrate replaces req.query with the validated values: q trimmed,
// k/ef_search as numbers, defaults filled in.
export const validateLogSearch = celebrate({
   [Segments.QUERY]: Joi.object({
      q: Joi.string().trim().max(SEARCH_DEFAULTS.maxQueryLength).required().messages({
         "any.required": "q is required",
         "string.empty": "q is required",
         "string.base": "q is required",
         "string.max": `q must be at most ${SEARCH_DEFAULTS.maxQueryLength} characters`,
      }),
      mode: Joi.string().valid(...SEARCH_MODES).default(SEARCH_DEFAULTS.mode).messages({
         "any.only": `mode must be one of ${SEARCH_MODES.join(", ")}`,
         "string.base": `mode must be one of ${SEARCH_MODES.join(", ")}`,
      }),
      k: intParam("k", 1, SEARCH_DEFAULTS.maxK, SEARCH_DEFAULTS.k),
      ef_search: intParam("ef_search", efMin, efMax, SEARCH_DEFAULTS.efSearch),
   }),
});

export interface LogSearchQuery {
   q: string;
   mode: SearchMode;
   k: number;
   ef_search: number;
}
