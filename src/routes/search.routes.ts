import { Router } from "express";
import { getLogSearch } from "../controllers/search.controller";

const router = Router();

// GET /search/logs?q=redis is down&mode=hybrid|vector|fulltext|like&k=10&ef_search=100
router.get("/logs", getLogSearch);

export default router;
