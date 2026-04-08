import "dotenv/config";
import type { Knex } from "knex";

const config: Knex.Config = {
   client: "pg",
   connection: {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || "sql_lab",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
   },
   migrations: {
      directory: "./src/db/migrations",
   },
   seeds: {
      directory: "./src/db/seeds",
   },
};

export default config;
