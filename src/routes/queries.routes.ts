import { Router } from "express";
import {
   getJoinQuery,
   getOptimizedQuery,
   getSlowQuery,
} from "../controllers/queries.controller";

const router = Router();

router.get("/slow", getSlowQuery);
router.get("/optimized", getOptimizedQuery);
router.get("/join", getJoinQuery);

export default router;
