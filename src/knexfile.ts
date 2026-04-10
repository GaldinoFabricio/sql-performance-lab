import dotenv from "dotenv";
import path from "path";
import type { Knex } from "knex";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const srcDir = path.resolve(__dirname);

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
      directory: path.join(srcDir, "db", "migrations"),
   },
   seeds: {
      directory: path.join(srcDir, "db", "seeds"),
   },
};

export default config;
