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

Headline: with 1M rows, an HNSW index (`ef_search` 160) answers in ~5.5 ms instead of 231 ms, but finds only 68% of the true nearest neighbours for typed queries. Searching one embedding per log template (68 of them) instead of one per row gets at least 95% precision in under 1 ms at every size (98.3% at 10k and 100k in the later runs). A partial HNSW index without INFO logs (74% of the rows) raises HNSW precision at 1M from 73% to 87%, and builds in 68 s instead of 5.8 min (separate runs). Typed error codes such as `40P01`, which never appear in the message text, now match through the `error_code` column: precision on code queries went from 62% to 99.7% at 100k. A cross-encoder reranker that reads LLM-written descriptions of the templates (written once, not per search) takes typed-query precision at 100k from 88.7–92.2% to 98.2% across three index builds, near the candidates' ceiling, for 12 ms. Full write-up, chart and conclusions: [SEMANTIC_SEARCH.md](./SEMANTIC_SEARCH.md).

#### Working at 10k and projecting to 1M

A 1M-row eval takes hours (embedding, ground truth, HNSW builds), so day-to-day runs use 10k rows (embedding takes about 1 minute, each eval a few minutes). The repository has real runs at 10k, 100k and 1M, so the shortcut can be checked: project 1M from 10k and 100k, then compare with what was measured (HNSW m=32, ef_construction=200, ef_search=40).

| Metric | Projected 1M | Measured 1M | Error |
| ------ | ------------ | ----------- | ----- |
| HNSW size | 1,400 MB | 1,455 MB | -4% |
| Full-text p95 (free text) | 1,013 ms | 994 ms | +2% |
| Hybrid precision@10 (free text) | 73.8% | 75.5% | -2% |
| HNSW build time | 210 s | 346 s | -39% |
| Exact vector search p50 (free text) | 131 ms | 231 ms | -43% |
| Exact vector search p50 (log queries) | 138 ms | 232 ms | -41% |
| HNSW p50 latency | 0.69 ms | 2.97 ms | -77% |
| HNSW recall@10 (free text) | 68.2% | 54.8% | +24% |
| HNSW recall@10 (log queries) | 96.6% | 90.0% | +7% |

(Power law through 10k and 100k for sizes and times, a straight line in log10(rows) for recall and precision. The 10k and 1M runs are from 2026-11-24, the 100k run from 2026-11-15; it is not confirmed that they ran on the same machine. Here MB is 10⁶ bytes; the generated tables in SEMANTIC_SEARCH.md divide by 1,048,576.)

- **10k is useful for trying ideas, not for final verdicts.** The order of exact vector, HNSW and LIKE holds at every size, but other results flip, so confirm a decision at 100k or 1M. Hybrid leads full-text at 10k (87-90% against 80%) and trails it at 1M (75-78% against 80.5%); on mixed queries it already trails at 100k (88.8% against 94.2%, after leading 96.3% to 94.2% at 10k). At `ef_search` 160, HNSW is above fixed hybrid at 10k and 100k and below it at 1M. The first reranker, reading code and message, lowered precision at 10k (96.5% to 93.5% at top 50) and raised it at 100k (89.2% to 93.0%). The current reranker has no 1M run.
- **Projecting from 10k and 100k together works well** for index size, tail latency of full-text and hybrid precision.
- **10k is too optimistic** about HNSW recall and too cheap on latency and build time. Recall falls faster past 100k (free text, m=32: -11 points from 10k to 100k, -24 from 100k to 1M). Cache pressure may add to the latency growth, but it was not measured. Plan a higher `ef_search` for 1M and use the measured 1M numbers for latency and build time.

Latest 10k run (`evals/results/search-10k.json`, `rerank-10k-template.json`): the template method reaches 98.3% precision on free text, the router beats fixed RRF by +2.8 points (noise 0.8), and the reranker takes hybrid from 96.5% to 97.0% (top 20) and 98.3% (top 50, the ceiling).

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
│   ├── routes/ controllers/ services/ validators/   # queries, benchmarks and search (/search/logs)
│   ├── search/        # hybrid RRF, routing, templates, error codes, cross-encoder reranker
│   ├── logs/          # synthetic log generator, template miner, LLM descriptions
│   ├── embeddings/    # all-MiniLM-L6-v2 on CPU (Transformers.js)
│   ├── evals/         # ground truth and metrics (recall, precision)
│   ├── scripts/       # seed, embed, eval:* and templates:* commands (see below)
│   ├── db/            # knex, migrations, seeds
│   ├── __tests__/     # Vitest
│   └── app.ts
├── evals/
│   ├── ground_truth.{10k,100k,1m}.json   # exact top-10 per sampled log, one file per table size
│   ├── text_queries.json, code_queries.json
│   ├── results/       # one JSON per run (search-10k.json, rerank-100k-template.json, ...)
│   └── plans/         # EXPLAIN ANALYZE on 1M logs
├── SEMANTIC_SEARCH.md
├── docker-compose.yml
└── package.json
```

---

## Running Locally

**Prerequisites:** Node.js 20.19+, 22.13+ or 24+, pnpm, Docker (PostgreSQL 17 + pgvector).

```bash
[ -f .env ] || echo "DB_PORT=5433" > .env   # Compose publishes the db on 5433, the app defaults to 5432; an existing .env needs DB_PORT too
docker compose up -d db   # db only: the app service reseeds on every start, replacing logs and templates
pnpm install
pnpm migrate
pnpm seed:run             # 100k users, 50k orders, 150k order_items
pnpm dev
```

### Semantic search evals (10k logs)

```bash
pnpm model:fetch                                  # download the embedding model once
LOGS_COUNT=10000 pnpm seed:logs && pnpm embed:logs
pnpm templates:build                              # one embedding per log template; rerun after reseeding
pnpm eval:ground-truth --out=evals/ground_truth.10k.json
pnpm eval:search --truth=evals/ground_truth.10k.json
pnpm eval:partial-hnsw --rebuild=3 --rebuild-full=3
pnpm eval:rerank --stages=hybrid --doc=template
```

Use one ground-truth file per table size and pass it with `--truth`. Writing a 10k ground truth to `ground_truth.1m.json` overwrites the 1M one. For 100k or 1M set `LOGS_COUNT` and the matching file name. The full list of commands is in [SEMANTIC_SEARCH.md](./SEMANTIC_SEARCH.md#reproduce).

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
| GET    | `/search/logs?q=&mode=`   | Log search: `hybrid` (default), `vector`, `fulltext`, `like`, `template`; optional `k`, `ef_search`, `include_info` (INFO logs are left out by default), `rerank` (cross-encoder over the top N; 50 by default in hybrid, `rerank=0` turns it off), and for hybrid `vw`, `fw`, `cw`, `tw`, `rrf_k`, `route` ([SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md#api)) |

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
