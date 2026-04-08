import { defineConfig } from "vitest/config";

export default defineConfig({
   test: {
      include: ["src/**/*.test.ts"], // point at .ts source, not build/
      environment: "node",
      env: {
         DB_HOST: "localhost",
         DB_PORT: "5433",
         DB_USER: "postgres",
         DB_PASSWORD: "postgres",
         DB_NAME: "sql_lab",
      },
   },
});
