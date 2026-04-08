import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
   await knex.raw(
      "CREATE INDEX IF NOT EXISTS idx_users_country ON users(country)",
   );
}

export async function down(knex: Knex): Promise<void> {
   await knex.raw("DROP INDEX IF EXISTS idx_users_country");
}
