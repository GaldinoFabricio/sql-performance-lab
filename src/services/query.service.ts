import db from "../db/knex";

// One definition per query: /queries/slow|optimized run it, /queries/explain/:type
// explains it. Keeping them apart let the plan describe a different query.
const slowUsersQuery = () =>
   db("users").where("country", "like", "%B%").select("id", "name", "email", "country");
const fastUsersQuery = () =>
   db("users").where("country", "BR").select("id", "name", "email", "country");

export async function runSlowQuery() {
   const start = performance.now();

   const rows = await slowUsersQuery();

   return {
      type: "slow",
      description: "LIKE com wildcard — força full table scan",
      rows: rows.length,
      ms: (performance.now() - start).toFixed(2),
      sample: rows.slice(0, 3),
   };
}

export async function runOptimizedQuery() {
   const start = performance.now();

   const rows = await fastUsersQuery();

   return {
      type: "optimized",
      description: "Igualdade exata — aproveita índice em country",
      rows: rows.length,
      ms: (performance.now() - start).toFixed(2),
      sample: rows.slice(0, 3),
   };
}

export async function runJoinSlow() {
   const start = performance.now();
   const rows = await db.raw(`
    SELECT users.name, orders.total, orders.status
    FROM users
    JOIN orders ON users.id = orders.user_id
    WHERE orders.status = 'completed'
    ORDER BY orders.total DESC
    LIMIT 100
  `);
   return {
      type: "join-slow",
      description: "JOIN sem índice composto — filesort + full scan em orders",
      rows: rows.rows.length,
      ms: (performance.now() - start).toFixed(2),
   };
}

export async function runJoinOptimized() {
   const start = performance.now();
   const rows = await db("orders")
      .join("users", "orders.user_id", "users.id")
      .where("orders.status", "completed")
      .orderBy("orders.total", "desc")
      .select("users.name", "orders.total", "orders.status")
      .limit(100);
   return {
      type: "join-optimized",
      description: "JOIN com índice em (status, user_id) — index scan",
      rows: rows.length,
      ms: (performance.now() - start).toFixed(2),
   };
}

/**
 * The "fast" plan is taken with enable_seqscan = off so it shows the index
 * path. The planner may pick a Seq Scan for this query on its own (country
 * = 'BR' keeps a share of the table), so `planner` says which one this is.
 */
export async function explainQuery(type: "slow" | "fast") {
   const query = (type === "slow" ? slowUsersQuery() : fastUsersQuery()).toSQL();

   if (type === "fast") {
      return await db.transaction(async (trx) => {
         await trx.raw("SET LOCAL enable_seqscan = OFF");
         const result = await trx.raw(
            `EXPLAIN ANALYZE ${query.sql}`,
            query.bindings,
         );
         return {
            type,
            planner: "forced: enable_seqscan = off",
            plan: result.rows.map((r: any) => r["QUERY PLAN"]),
         };
      });
   }

   const result = await db.raw(`EXPLAIN ANALYZE ${query.sql}`, query.bindings);
   return {
      type,
      planner: "default",
      plan: result.rows.map((r: any) => r["QUERY PLAN"]),
   };
}
