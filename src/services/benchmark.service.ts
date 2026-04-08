import db from "../db/knex";

async function measureQuery(fn: () => Promise<any>, iterations = 5) {
   const times: number[] = [];

   for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
   }

   const avg = times.reduce((a, b) => a + b, 0) / times.length;
   const min = Math.min(...times);
   const max = Math.max(...times);

   return {
      avg: avg.toFixed(2),
      min: min.toFixed(2),
      max: max.toFixed(2),
      iterations,
   };
}

export async function executeBenchmark() {
   const slowStats = await measureQuery(() =>
      db("users").where("country", "like", "%BR%").select("id"),
   );

   const fastStats = await measureQuery(() =>
      db("users").where("country", "BR").select("id"),
   );

   const improvement = (
      (1 - Number(fastStats.avg) / Number(slowStats.avg)) *
      100
   ).toFixed(1);

   return {
      slow: slowStats,
      fast: fastStats,
      improvement: `${improvement}%`,
   };
}
