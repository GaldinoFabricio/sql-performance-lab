import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
   await knex.schema.alterTable("orders", (table) => {
      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      table.string("country", 2);
      table.string("sales_channel"); // web, mobile, partner
   });

   await knex.schema.alterTable("products", (table) => {
      table.string("sku").unique();
      table.boolean("active").defaultTo(true);
   });
}

export async function down(knex: Knex): Promise<void> {
   await knex.schema.alterTable("orders", (table) => {
      table.dropColumn("created_at");
      table.dropColumn("updated_at");
      table.dropColumn("country");
      table.dropColumn("sales_channel");
   });

   await knex.schema.alterTable("products", (table) => {
      table.dropColumn("sku");
      table.dropColumn("active");
   });
}
