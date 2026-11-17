import express, { NextFunction, Request, Response } from "express";
import { isCelebrateError } from "celebrate";
import benchmarkRoutes from "./routes/benchmarks.routes";
import queryRoutes from "./routes/queries.routes";
import searchRoutes from "./routes/search.routes";

const app = express();

app.use(express.json());
app.use("/benchmarks", benchmarkRoutes);
app.use("/queries", queryRoutes);
app.use("/search", searchRoutes);

app.get("/health", (req, res) => {
   res.status(200).json({ status: "OK" });
});

// Validation errors (celebrate) keep the API's { error: "<message>" } shape.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
   if (!isCelebrateError(err)) return next(err);
   const [first] = err.details.values();
   res.status(400).json({ error: first?.details[0]?.message ?? "Invalid request" });
});

export default app;
