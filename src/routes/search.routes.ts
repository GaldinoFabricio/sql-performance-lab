import { Router } from "express";
import { getLogSearch } from "../controllers/search.controller";
import { validateLogSearch } from "../validators/search.validator";

const router = Router();

// GET /search/logs?q=redis is down&mode=hybrid|vector|fulltext|like&k=10&ef_search=100
router.get("/logs", validateLogSearch, getLogSearch);

export default router;
