# SQL Performance Lab

> A hands-on project demonstrating the real impact of SQL query optimization — with measured results.

---

## Overview

This project simulates performance bottlenecks in relational databases and shows how to fix them using indexing strategies, query restructuring, and execution plan analysis.

It was built to go beyond learning SQL syntax — the goal is to understand **why** queries are slow and how to make them fast, with real benchmark numbers to back it up.

---

## Results

Tested on a local PostgreSQL instance with 100,000 users, 50,000 orders, and 150,000 order_items.

| Experiment                          | Before   | After   | Improvement |
| ----------------------------------- | -------- | ------- | ----------- |
| Full table scan vs indexed query    | 152.05ms | 3.07ms  | **98.0%**   |
| LIKE wildcard vs exact match        | 60.81ms  | 12.91ms | **78.8%**   |
| JOIN (users × orders × order_items) | —        | 19.92ms | —           |

See [RESULTS.md](./RESULTS.md) for the full benchmark breakdown.

---

## The Problem

Poorly designed queries cause:

- slow API response times
- high database CPU and memory usage
- increased infrastructure costs
- degraded user experience at scale

Most developers learn SQL syntax but not how to optimize it. This project bridges that gap.

---

## Experiments

### 1. Full Table Scan vs Indexed Query

Compares a query scanning every row in the table against one that uses a B-tree index for direct lookup.

### 2. LIKE Wildcard vs Exact Match

Shows how a leading wildcard (`%value%`) bypasses indexes entirely, forcing a sequential scan regardless of table size.

### 3. JOIN Optimization

Measures the cost of joining three tables (`users`, `orders`, `order_items`) and how FK indexes affect performance.

### 4. Benchmark Comparison

A single endpoint that runs both the slow and optimized versions and returns the improvement percentage.

---

## Tech Stack

- **PostgreSQL**
- **Node.js** with TypeScript
- **Express** — HTTP layer
- **Knex.js** — query builder and migrations
- **Faker.js** — realistic dataset generation
- **Vitest + Supertest** — automated tests

---

## Project Structure

```
sql-performance-lab/
├── src/
│   ├── routes/
│   │   ├── benchmarks.routes.ts
│   │   └── queries.routes.ts
│   ├── controllers/
│   │   ├── benchmarks.controller.ts
│   │   └── queries.controller.ts
│   ├── services/
│   │   ├── benchmark.service.ts
│   │   └── query.service.ts
│   ├── db/
│   │   ├── knex.ts
│   │   ├── migrations/
│   │   └── seeds/
│   └── app.ts
├── RESULTS.md
├── knexfile.ts
└── package.json
```

---

## Running Locally

**Prerequisites:** Node.js 18+, PostgreSQL running locally.

```bash
# install dependencies
pnpm install

# run migrations
pnpm knex migrate:latest

# seed the database (100k users, 50k orders, 150k order_items)
pnpm knex seed:run

# start the server
pnpm dev
```

---

## Endpoints

| Method | Route                | Description                        |
| ------ | -------------------- | ---------------------------------- |
| GET    | `/queries/slow`      | Full table scan with LIKE wildcard |
| GET    | `/queries/optimized` | Exact match using index            |
| GET    | `/queries/join`      | JOIN across three tables           |
| GET    | `/benchmarks/run`    | Side-by-side benchmark comparison  |

**Example response from `/benchmarks/run`:**

```json
{
  "slow": { "rows": 33321, "ms": "152.05" },
  "fast": { "rows": 0, "ms": "3.07" },
  "improvement": "98.0%"
}
```

---

## Indexes

```sql
CREATE INDEX idx_users_country        ON users(country);
CREATE INDEX idx_orders_status        ON orders(status);
CREATE INDEX idx_orders_user_id       ON orders(user_id);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
```

---

## Running Tests

```bash
pnpm test
```

Tests use Vitest + Supertest and assert that the optimized query is measurably faster than the slow one.

---

## Key Takeaways

- A single index reduced query time from **152ms to 3ms** — a 98% improvement
- `LIKE '%value%'` bypasses indexes entirely regardless of table size
- Exact match (`=`) on an indexed column is significantly faster than any wildcard pattern
- Foreign key indexes matter — without them, every JOIN performs a sequential scan on the related table
