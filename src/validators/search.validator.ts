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

// Hybrid RRF weight: must be in [min, max]. No default on purpose: "" or missing
// stays undefined, so the service knows the caller did not set it and can route.
const weightParam = (name: string) => {
   const [min, max] = SEARCH_DEFAULTS.weightRange;
   const message = `${name} must be a number between ${min} and ${max}`;
   return Joi.number().min(min).max(max).empty("").messages({
      "number.base": message,
      "number.min": message,
      "number.max": message,
      "number.infinity": message,
   });
};

const [efMin, efMax] = SEARCH_DEFAULTS.efSearchRange;
const [rrfMin, rrfMax] = SEARCH_DEFAULTS.rrfKRange;

// GET /search/logs query params.
const fields = {
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
   vw: weightParam("vw"),
   fw: weightParam("fw"),
   // route=true picks the hybrid weights from the query (routing.ts). Off by default:
   // at 10k rows routing gained +2.7 precision points, within the build-to-build
   // noise (6.7), so the fixed 1/1 stays the default until a larger eval says otherwise.
   route: Joi.boolean().truthy("1").falsy("0").empty("").default(false).messages({
      "boolean.base": "route must be true or false",
   }),
   rrf_k: intParam("rrf_k", rrfMin, rrfMax, SEARCH_DEFAULTS.rrfK),
   // INFO logs are left out by default: the HNSW index is partial (WHERE level <> 'INFO').
   // include_info=true searches them too, without the index (exact scan for vector/hybrid).
   include_info: Joi.boolean().truthy("1").falsy("0").empty("").default(false).messages({
      "boolean.base": "include_info must be true or false",
   }),
};

// celebrate replaces req.query with the validated values: q trimmed, k/ef_search as
// numbers, defaults filled in.
//
// Unknown params are rejected on purpose: a typo like `ef_serach=1000` would otherwise
// be ignored silently and the request would run with the default, which is misleading
// when the point of the call is to compare settings.
export const validateLogSearch = celebrate({
   [Segments.QUERY]: Joi.object(fields)
      // vw = fw = 0 gives every row a score of 0, so the order would be just the id.
      .custom((v, helpers) => (v.vw === 0 && v.fw === 0 ? helpers.error("weights.zero") : v))
      .messages({
         "object.unknown": `unknown parameter {#key}; allowed: ${Object.keys(fields).join(", ")}`,
         "weights.zero": "vw and fw cannot both be 0",
      }),
});

export interface LogSearchQuery {
   q: string;
   mode: SearchMode;
   k: number;
   ef_search: number;
   vw?: number;
   fw?: number;
   rrf_k: number;
   route: boolean;
   include_info: boolean;
}
