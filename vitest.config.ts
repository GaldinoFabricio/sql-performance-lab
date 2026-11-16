import dotenv from "dotenv";
import { defineConfig } from "vitest/config";

// Read .env first, so the tests use the same database as pnpm migrate.
// Variables already set in the shell (CI) still win.
dotenv.config({ quiet: true });

export default defineConfig({
   test: {
      include: ["src/**/*.test.ts"],
      environment: "node",
      env: {
         DB_HOST: process.env.DB_HOST ?? "localhost",
         DB_PORT: process.env.DB_PORT ?? "5433",
         DB_USER: process.env.DB_USER ?? "postgres",
         DB_PASSWORD: process.env.DB_PASSWORD ?? "postgres",
         DB_NAME: process.env.DB_NAME ?? "sql_lab",
      },
   },
});
