import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
   await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON orders(ordered_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status_ordered_user
      ON orders(status, ordered_at, user_id);

    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
  `);
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw(`
    DROP INDEX IF EXISTS idx_orders_user_id;
    DROP INDEX IF EXISTS idx_orders_status;
    DROP INDEX IF EXISTS idx_orders_ordered_at;
    DROP INDEX IF EXISTS idx_orders_status_ordered_user;
    DROP INDEX IF EXISTS idx_order_items_order_id;
    DROP INDEX IF EXISTS idx_order_items_product_id;
    DROP INDEX IF EXISTS idx_products_category;
  `);
}
