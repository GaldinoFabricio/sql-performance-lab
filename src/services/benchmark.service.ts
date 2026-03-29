import db from "../db/knex";

export async function executeBenchmark() {
   const start = performance.now();

   const slow = await db("users").where("email", "like", "%@gmail.com%");
   const slowTime = performance.now() - start;

   const start2 = performance.now();
   const fast = await db("users").where("email", "test@gmail.com");
   const fastTime = performance.now() - start2;

   return {
      slow: { rows: slow.length, ms: slowTime.toFixed(2) },
      fast: { rows: fast.length, ms: fastTime.toFixed(2) },
      improvement: `${((1 - fastTime / slowTime) * 100).toFixed(1)}%`,
   };
}
