import { Router } from "express";
import { runBenchmark } from "../controllers/benchmarks.controller";

const router = Router();

router.get("/run", runBenchmark);

export default router;
