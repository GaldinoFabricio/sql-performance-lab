import { Request, Response } from "express";
import { executeBenchmark } from "../services/benchmark.service";

export async function runBenchmark(req: Request, res: Response) {
   try {
      const result = await executeBenchmark();
      res.json(result);
   } catch (err) {
      res.status(500).json({ error: "Benchmark failed", detail: String(err) });
   }
}
