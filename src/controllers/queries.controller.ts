import { Request, Response } from "express";
import {
   runJoinQuery,
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

export async function getJoinQuery(req: Request, res: Response) {
   try {
      const result = await runJoinQuery();
      res.json(result);
   } catch (err) {
      res.status(500).json({ error: "Query failed", detail: String(err) });
   }
}
