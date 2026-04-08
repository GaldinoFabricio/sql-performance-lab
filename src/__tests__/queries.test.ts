import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import db from "../db/knex";

beforeAll(async () => {
   await db.migrate.latest();
});

afterAll(async () => {
   await db.destroy();
});

describe("GET /queries/slow", () => {
   it("retorna status 200 com tempo e linhas", async () => {
      const res = await request(app).get("/queries/slow");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("ms");
      expect(res.body).toHaveProperty("rows");
      expect(res.body.type).toBe("slow");
   });

   it("retorna sample como array", async () => {
      const res = await request(app).get("/queries/slow");

      expect(Array.isArray(res.body.sample)).toBe(true);
   });
});

describe("GET /queries/optimized", () => {
   it("retorna status 200", async () => {
      const res = await request(app).get("/queries/optimized");

      expect(res.status).toBe(200);
      expect(res.body.type).toBe("optimized");
   });

   it("é mais rápido que a slow query", async () => {
      const slow = await request(app).get("/queries/slow");
      const fast = await request(app).get("/queries/optimized");

      expect(Number(fast.body.ms)).toBeLessThan(Number(slow.body.ms));
   });
});

describe("GET /queries/join/slow", () => {
   it("retorna status 200 com sample", async () => {
      const res = await request(app).get("/queries/join/slow");

      expect(res.status).toBe(200);
      expect(typeof res.body.rows).toBe("number");
      expect(typeof res.body.ms).toBe("string");
   });
});

describe("GET /queries/join/optimized", () => {
   it("retorna status 200 com sample", async () => {
      const res = await request(app).get("/queries/join/optimized");

      expect(res.status).toBe(200);
      expect(typeof res.body.rows).toBe("number");
      expect(typeof res.body.ms).toBe("string");
   });

   it("é mais rápido que a join slow query", async () => {
      const runs = 10;

      const avg = async (url: string) => {
         const times = await Promise.all(
            Array.from({ length: runs }, () =>
               request(app)
                  .get(url)
                  .then((r) => Number(r.body.ms)),
            ),
         );
         return times.reduce((a, b) => a + b, 0) / runs;
      };

      const slowAvg = await avg("/queries/join/slow");
      const fastAvg = await avg("/queries/join/optimized");

      console.log("Slow avg ms:", slowAvg);
      console.log("Optimized avg ms:", fastAvg);

      expect(fastAvg).toBeLessThan(slowAvg);
   });
});

describe("GET /queries/explain/:type", () => {
   it("retorna explain para slow", async () => {
      const res = await request(app).get("/queries/explain/slow");

      expect(res.status).toBe(200);
      expect(res.body.type).toBe("slow");
      expect(Array.isArray(res.body.plan)).toBe(true);
      expect(
         res.body.plan.some((line: string) => line.includes("Execution Time")),
      ).toBe(true);
   });

   it("retorna explain para optimized", async () => {
      const res = await request(app).get("/queries/explain/fast");

      expect(res.status).toBe(200);
      expect(res.body.type).toBe("fast");
      expect(Array.isArray(res.body.plan)).toBe(true);
      expect(
         res.body.plan.some(
            (line: string) =>
               line.includes("Index Scan") ||
               line.includes("Bitmap Index Scan"),
         ),
      ).toBe(true);
   });
});
