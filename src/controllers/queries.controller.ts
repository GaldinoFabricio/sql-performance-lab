import { Request, Response } from "express";
import {
   explainQuery,
   runJoinOptimized,
   runJoinSlow,
   runOptimizedQuery,
   runSlowQuery,
} from "../services/query.service";

export async function getSlowQuery(req: Request, res: Response) {
   try {
      const result = await runSlowQuery();
      res.json(result);
   } catch (err) {
      res.status(500).json({ error: "Query failed", detail: String(err) });
   }
}

export async function getOptimizedQuery(req: Request, res: Response) {
   try {
      const result = await runOptimizedQuery();
      res.json(result);
   } catch (err) {
      res.status(500).json({ error: "Query failed", detail: String(err) });
   }
}

export async function getJoinSlowQuery(req: Request, res: Response) {
   try {
      const result = await runJoinSlow();

      res.status(200).json(result);
   } catch (err) {
      res.status(500).json({ error: "Query failed", detail: String(err) });
   }
}

export async function getJoinOptimizedQuery(req: Request, res: Response) {
   try {
      const result = await runJoinOptimized();
      res.json(result);
   } catch (err) {
      res.status(500).json({ error: "Query failed", detail: String(err) });
   }
}

export async function getExplain(req: Request, res: Response) {
   const type = req.params.type;

   if (type !== "slow" && type !== "fast") {
      return res.status(400).json({ error: "type must be 'slow' or 'fast'" });
   }

   try {
      const result = await explainQuery(type);
      res.json(result);
   } catch (err) {
      res.status(500).json({ error: "EXPLAIN failed", detail: String(err) });
   }
}
