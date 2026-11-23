# Result Caching

This lab does not cache query or search results (for example in Redis).

## Why this is out of scope

The lab shows how to fix slow queries and how to measure which search method finds the item. A cache does neither: it hides a slow query instead of fixing it, and it does not change which of `LIKE`, full-text, vector or hybrid search returns the right logs.

The measurement is also foregone. A cache hit is a key lookup of about a millisecond, and a miss is the full embed, SQL and rerank path, so an experiment would confirm what is already known.

It has real costs. It needs a new service in `docker-compose.yml`, a client dependency and configuration, and a cache in front of `/search/logs` can silently corrupt the latency numbers the evals report. Cache expiry and failure handling are also production hardening, which is out of scope (see `production-hardening.md`).

This would be worth reconsidering only as a deliberate chapter about caching itself, such as hit rate, TTL trade-offs, or cache vs index as two ways to fix the same slow query.

## Prior requests

- Add Redis caching for `/search/logs` results (raised in a working session, no issue filed).
