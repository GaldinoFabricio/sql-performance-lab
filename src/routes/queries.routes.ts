import { Router } from "express";
import {
   getExplain,
   getJoinOptimizedQuery,
   getJoinSlowQuery,
   getOptimizedQuery,
   getSlowQuery,
} from "../controllers/queries.controller";

const router = Router();

router.get("/slow", getSlowQuery);
router.get("/optimized", getOptimizedQuery);
router.get("/join/slow", getJoinSlowQuery);
router.get("/join/optimized", getJoinOptimizedQuery);
router.get("/explain/:type", getExplain);

export default router;
