import { fetchModel, MODELS, modelDir, verifyModel } from "../embeddings/model";

// Usage: pnpm model:fetch | pnpm model:verify  (both models: embeddings and reranker)
async function main() {
   const cmd = process.argv[2];
   if (cmd !== "fetch" && cmd !== "verify") {
      console.error("usage: model.ts fetch|verify");
      process.exit(2);
   }

   let failed = false;
   for (const spec of MODELS) {
      console.log(`${spec.id}@${spec.revision.slice(0, 7)} -> ${modelDir(spec)}`);
      if (cmd === "fetch") await fetchModel(spec);

      const results = await verifyModel(spec);
      for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.file}${r.reason ? ` (${r.reason})` : ""}`);
      failed ||= results.some((r) => !r.ok);
   }
   if (failed) {
      console.error("model files do not match the pinned SHA-256 hashes");
      process.exit(1);
   }
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
