# SQL Performance Lab

> A hands-on project demonstrating the real impact of SQL query optimization — with measured results.

---

## Overview

This project simulates performance bottlenecks in relational databases and shows how to fix them using indexing strategies, query restructuring, and execution plan analysis.

It was built to go beyond learning SQL syntax — the goal is to understand **why** queries are slow and how to make them fast, with real benchmark numbers to back it up.

---

## Results

Tested on a local PostgreSQL instance with 100,000 users, 50,000 orders, and 150,000 order_items.

| Experiment                       | Before        | After        | Improvement |
| -------------------------------- | ------------- | ------------ | ----------- |
| Full table scan vs indexed query | 21.36ms (avg) | 5.10ms (avg) | **76.1%**   |
| LIKE wildcard vs exact match     | 37.06ms       | 1.99ms       | **94.6%**   |
| JOIN slow vs JOIN optimized      | 19.12ms       | 14.56ms      | **23.8%**   |

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

Compares a query using `LIKE '%BR%'` (forces a sequential scan across all rows) against an exact match (`= 'BR'`) that hits the B-tree index directly.

The execution plan confirms the difference:

**Slow** — Sequential scan, 99,614 rows filtered:

```
Seq Scan on users  (cost=0.00..10349.00 rows=9 width=4)
  Filter: ((country)::text ~~ '%BR%'::text)
  Rows Removed by Filter: 99614
  Execution Time: 18.232 ms
```

**Fast** — Bitmap index scan, 386 rows:

```
Bitmap Heap Scan on users  (cost=19.49..1339.16 rows=397 width=4)
  ->  Bitmap Index Scan on idx_users_country
        Index Cond: ((country)::text = 'BR'::text)
  Execution Time: 1.466 ms
```

### 2. LIKE Wildcard vs Exact Match

Shows how a leading wildcard (`%value%`) bypasses indexes entirely, forcing a sequential scan regardless of table size.

### 3. JOIN Optimization

Measures the cost of joining three tables (users, orders, order_items) with and without a composite index on `orders(status, ordered_at, user_id)`.

### 4. Benchmark Comparison

A single endpoint that runs both the slow and optimized versions multiple times and returns average, min, max, and improvement percentage.

### 5. Semantic Search over Logs (pgvector)

`GET /search/logs` searches a synthetic `logs` table four ways: `LIKE`, full-text (GIN), vectors (exact and HNSW) and a hybrid of both. Each is measured with recall and precision evals at 10k, 100k and 1M rows.

Headline: with 1M rows, an HNSW index answers in ~2 ms instead of 220 ms, but finds only 64% of the true nearest neighbours for typed queries. Searching one embedding per log template (68 of them) instead of one per row gets 95% precision in under 1 ms at every size. A partial HNSW index without INFO logs (74% of the rows) raises HNSW precision at 1M from 72% to 87%, and builds in 68 s instead of 77 min. Typed error codes such as `40P01`, which never appear in the message text, now match through the `error_code` column: precision on code queries went from 62% to 99.7% at 100k. Full write-up, chart and conclusions: [SEMANTIC_SEARCH.md](./SEMANTIC_SEARCH.md).

### 6. Query Plans on 1M Logs

`pnpm eval:plans` saves `EXPLAIN (ANALYZE, BUFFERS)` for 20 experiments on the 1M-row `logs` table. Topics: a composite index created `CONCURRENTLY`, the leftmost prefix rule, a redundant index and INSERT cost (measured in WAL bytes), 500 vs 1M rows, a low-selectivity index, HNSW + `WHERE` (and four fixes), and `pg_stat_statements` ranked by total vs mean time. The plans are explained node by node, in Portuguese, in [evals/plans/README.md](./evals/plans/README.md).

---

## Tech Stack

- **PostgreSQL**
- **Node.js** with TypeScript
- **Express** — HTTP layer
- **Knex.js** — query builder and migrations
- **Faker.js** — realistic dataset generation
- **pgvector** + **Transformers.js** (all-MiniLM-L6-v2, local CPU) — embeddings and vector search
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

| Method | Route                     | Description                                         |
| ------ | ------------------------- | --------------------------------------------------- |
| GET    | `/queries/slow`           | Full table scan with LIKE wildcard                  |
| GET    | `/queries/optimized`      | Exact match using index                             |
| GET    | `/queries/join/slow`      | JOIN without composite index (filesort + full scan) |
| GET    | `/queries/join/optimized` | JOIN with composite index (index scan)              |
| GET    | `/queries/explain/:type`  | Execution plan for `slow` or `fast`                 |
| GET    | `/benchmarks/run`         | Side-by-side benchmark comparison (5 iterations)    |
| GET    | `/search/logs?q=&mode=`   | Log search: `hybrid` (default), `vector`, `fulltext`, `like`, `template`; optional `k`, `ef_search`, `include_info` (INFO logs are left out by default), and for hybrid `vw`, `fw`, `cw`, `rrf_k`, `route` ([SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md#api)) |

**Example response from `/benchmarks/run`:**

```json
{
  "slow": { "avg": "21.36", "min": "14.61", "max": "46.39", "iterations": 5 },
  "fast": { "avg": "5.10", "min": "2.84", "max": "12.48", "iterations": 5 },
  "improvement": "76.1%"
}
```

**Example response from `/queries/explain/fast`:**

```json
{
  "type": "fast",
  "plan": [
    "Bitmap Heap Scan on users  (cost=19.49..1339.16 rows=397 width=4) (actual time=0.503..1.246 rows=386 loops=1)",
    "  ->  Bitmap Index Scan on idx_users_country",
    "        Index Cond: ((country)::text = 'BR'::text)",
    "Planning Time: 0.157 ms",
    "Execution Time: 1.466 ms"
  ]
}
```

---

## Indexes

```sql
-- Users
CREATE INDEX idx_users_country ON users(country);

-- Orders
CREATE INDEX idx_orders_user_id       ON orders(user_id);
CREATE INDEX idx_orders_status        ON orders(status);
CREATE INDEX idx_orders_ordered_at    ON orders(ordered_at);
CREATE INDEX idx_orders_status_ordered_user ON orders(status, ordered_at, user_id);

-- Order Items
CREATE INDEX idx_order_items_order_id   ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

-- Products
CREATE INDEX idx_products_category ON products(category);

-- Logs (semantic search chapter)
CREATE INDEX idx_logs_message_fts ON logs USING gin (to_tsvector('english', message));
CREATE INDEX idx_logs_embedding_hnsw ON logs USING hnsw (embedding vector_cosine_ops) WITH (m = 32, ef_construction = 200);
CREATE INDEX CONCURRENTLY idx_logs_service_created_at ON logs (service, created_at DESC);
```

---

## Running Tests

```bash
pnpm test
```

Tests use Vitest + Supertest and assert that the optimized query is measurably faster than the slow one.

---

## Key Takeaways

- `LIKE '%value%'` bypasses indexes entirely — exact match (`=`) on an indexed column is dramatically faster
- A composite index on `(status, ordered_at, user_id)` eliminates filesorts on JOIN-heavy queries
- Execution plans (`EXPLAIN ANALYZE`) are the most reliable way to confirm whether an index is actually being used
- Foreign key indexes matter — without them, every JOIN performs a sequential scan on the related table
