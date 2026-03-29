import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
   await knex.schema.createTable("users", (table) => {
      table.increments("id").primary();
      table.string("name").notNullable();
      table.string("email").notNullable().unique();
      table.string("password").notNullable();
      table.string("country", 2);
      table.boolean("active").defaultTo(true);
      table.timestamps(true, true);
   });

   await knex.schema.createTable("products", (table) => {
      table.increments("id").primary();
      table.string("name").notNullable();
      table.string("category").notNullable();
      table.decimal("price", 10, 2).notNullable();
      table.integer("stock").defaultTo(0);
      table.timestamps(true, true);
   });

   await knex.schema.createTable("orders", (table) => {
      table.increments("id").primary();
      table.integer("user_id").references("id").inTable("users");
      table.decimal("total", 10, 2).notNullable();
      table.string("status").notNullable();
      table.timestamp("ordered_at").defaultTo(knex.fn.now());
   });

   await knex.schema.createTable("order_items", (table) => {
      table.increments("id").primary();
      table.integer("order_id").references("id").inTable("orders");
      table.integer("product_id").references("id").inTable("products");
      table.integer("quantity").notNullable();
      table.decimal("unit_price", 10, 2).notNullable();
   });
}

export async function down(knex: Knex): Promise<void> {
   await knex.schema.dropTable("order_items");
   await knex.schema.dropTable("orders");
   await knex.schema.dropTable("products");
   await knex.schema.dropTable("users");
}
