# Benchmark Results

Real results measured on a local PostgreSQL instance with:

- 100,000 users
- 50,000 orders
- 150,000 order_items

## Query Performance

| Experiment      | Description                                     | Time    | Rows returned |
| --------------- | ----------------------------------------------- | ------- | ------------- |
| Slow query      | LIKE with wildcard — full table scan            | 60.81ms | 9,743         |
| Optimized query | Exact match — uses index on `country`           | 12.91ms | 400           |
| JOIN query      | users × orders × order_items filtered by status | 19.92ms | 100           |

## Benchmark: Full Table Scan vs Indexed Query

|                | Before index | After index |
| -------------- | ------------ | ----------- |
| Execution time | 152.05ms     | 3.07ms      |
| Improvement    | —            | **98.0%**   |

## Indexes Created

```sql
CREATE INDEX idx_users_country      ON users(country);
CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_user_id     ON orders(user_id);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
```

## Key Takeaways

- A single index reduced query time from **152ms to 3ms**
- LIKE with leading wildcard (`%value%`) bypasses indexes entirely
- Exact match (`=`) on an indexed column is ~5x faster than a wildcard scan
- Proper FK indexes make multi-table JOINs significantly cheaper
