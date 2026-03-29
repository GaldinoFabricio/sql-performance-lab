import { executeBenchmark } from "../services/benchmark.service";

async function main() {
   console.log("Rodando benchmark...");
   const result = await executeBenchmark();
   console.table(result);
   process.exit(0);
}

main();
