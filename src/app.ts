import express from "express";
import benchmarkRoutes from "./routes/benchmarks.routes";
import queryRoutes from "./routes/queries.routes";

const app = express();

app.use(express.json());
app.use("/benchmarks", benchmarkRoutes);
app.use("/queries", queryRoutes);

export default app;
