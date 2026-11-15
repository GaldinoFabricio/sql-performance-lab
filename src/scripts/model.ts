import { fetchModel, MODEL_ID, MODEL_REVISION, modelDir, verifyModel } from "../embeddings/model";

// Usage: pnpm model:fetch | pnpm model:verify
async function main() {
   const cmd = process.argv[2];
   if (cmd !== "fetch" && cmd !== "verify") {
      console.error("usage: model.ts fetch|verify");
      process.exit(2);
   }

   console.log(`${MODEL_ID}@${MODEL_REVISION.slice(0, 7)} -> ${modelDir()}`);
   if (cmd === "fetch") await fetchModel();

   const results = await verifyModel();
   for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.file}${r.reason ? ` (${r.reason})` : ""}`);
   if (results.some((r) => !r.ok)) {
      console.error("model files do not match the pinned SHA-256 hashes");
      process.exit(1);
   }
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
