import express from "express";
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

export default app;
