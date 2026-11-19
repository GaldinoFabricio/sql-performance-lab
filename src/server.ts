import app from "./app";
import { rerankerReady, warmUpReranker } from "./search/rerank";

const PORT = process.env.PORT || 3000;

app.listen(PORT, (err?: Error) => {
   if (err) {
      console.error(`Failed to start on port ${PORT}:`, err);
      process.exit(1);
   }
   console.log(`Running on http://localhost:${PORT}`);
   // Hybrid search reranks by default: load the model now, not on the first search.
   if (rerankerReady()) {
      warmUpReranker().catch((e) => console.error("reranker warm-up failed:", e));
   } else {
      console.warn("reranker model missing (pnpm model:fetch): hybrid search runs without reranking");
   }
});
