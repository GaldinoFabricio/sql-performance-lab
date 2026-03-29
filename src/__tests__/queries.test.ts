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

describe("GET /queries/join", () => {
   it("retorna status 200 com sample", async () => {
      const res = await request(app).get("/queries/join");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sample)).toBe(true);
   });
});

describe("GET /benchmarks/run", () => {
   it("retorna improvement com %", async () => {
      const res = await request(app).get("/benchmarks/run");

      expect(res.status).toBe(200);
      expect(res.body.improvement).toMatch(/%/);
   });

   it("fast é sempre mais rápido que slow", async () => {
      const res = await request(app).get("/benchmarks/run");

      expect(Number(res.body.fast.ms)).toBeLessThan(Number(res.body.slow.ms));
   });
});
