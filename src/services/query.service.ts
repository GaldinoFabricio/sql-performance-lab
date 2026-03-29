import db from "../db/knex";

export async function runSlowQuery() {
   const start = performance.now();

   const rows = await db("users")
      .where("country", "like", "%B%")
      .select("id", "name", "email", "country");

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

   const rows = await db("users")
      .where("country", "BR")
      .select("id", "name", "email", "country");

   return {
      type: "optimized",
      description: "Igualdade exata — aproveita índice em country",
      rows: rows.length,
      ms: (performance.now() - start).toFixed(2),
      sample: rows.slice(0, 3),
   };
}

export async function runJoinQuery() {
   const start = performance.now();

   const rows = await db("users")
      .join("orders", "users.id", "orders.user_id")
      .join("order_items", "orders.id", "order_items.order_id")
      .where("orders.status", "completed")
      .select(
         "users.name",
         "users.email",
         "orders.total",
         "orders.status",
         "order_items.quantity",
         "order_items.unit_price",
      )
      .limit(100);

   return {
      type: "join",
      description: "JOIN users × orders × order_items filtrado por status",
      rows: rows.length,
      ms: (performance.now() - start).toFixed(2),
      sample: rows.slice(0, 3),
   };
}
