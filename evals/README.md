# Evals

## `ground_truth.json`

For 100 logs sampled from the `logs` table (seed 42), the **exact** 10 nearest
neighbors by cosine distance (`<=>`), excluding the query row itself.
Regenerate with:

```bash
pnpm eval:ground-truth            # --queries=100 --k=10 --seed=42
```

It is the reference that approximate indexes (HNSW, IVFFlat) are measured
against: **recall@10 = how many of the exact top-10 the index also returned**.

### Why exact search is a valid ground truth

Recall here asks one narrow question: *did the index return the same rows a
perfect search would?* It says nothing about whether those rows are useful
(that's a separate relevance eval, using `root_cause`). For that narrow
question, a full sequential scan is the definition of correct:

1. **It is exhaustive.** The sequential scan computes the distance from the query
   to every one of the 10,000 rows and sorts them. Nothing is skipped, so
   nothing can be missed. An ANN index trades exactly this away for speed.
2. **It is enforced, not assumed.** The script disables index scans
   (`SET LOCAL enable_indexscan = off`, plus bitmap and index-only scans) and
   checks the `EXPLAIN` output for `Seq Scan on logs`. If an HNSW index exists
   later, the planner still can't use it silently.
3. **It is checked independently.** The same top-10 is recomputed in JavaScript
   with float64 brute force, which shares no code with Postgres. The run
   aborts if any of the 100 lists differ (allowing 1e-5 of rounding between
   pgvector's float32 and JS float64).
4. **It is deterministic and tied to the data.** The same seed and table always
   give the same file (only `created_at` changes). `fingerprint` is an md5 over
   every `(id, embedding)`. If the table is reseeded or re-embedded, the file
   is stale and must be regenerated.

### Ties

The table has exact duplicates (8,081 distinct messages in 10,000 rows, e.g.
`Health check OK`). Many rows can sit at exactly the 10th distance, so "the"
top-10 isn't unique. In the current file, 19 of the 100 queries have ties, and
one has 391 extra rows tied at the boundary.

So each query stores `kth_distance` and `ties_beyond_k`, and recall must be
**tie-aware**: a returned row counts as a hit if its true distance is
`<= kth_distance + 1e-5`, even if its id isn't in `neighbors`. Otherwise an
index that returns an equally close duplicate would be penalised for nothing.

Ordering is by `(distance, id)` in both SQL and JS, so the stored list itself
is reproducible.

### Known limits

- **Queries come from the corpus, and that flatters HNSW.** A log used as a
  query sits *inside* the data (its neighbors are at distance 0.00–0.10), so
  the graph search finds them easily. Typed searches like "redis is down" land
  *outside* the data (nearest neighbor at ~0.4), and there HNSW recall drops
  sharply. Phase 3 showed this: at 10k rows with pgvector's default build,
  `ef_search=40` gives 99.5% recall on log queries but 79% on free text. So
  `pnpm eval:search` also measures recall for `text_queries.json`. Exact
  search is the truth for any query vector, so it computes the exact k-th
  distance for each free-text query with the same forced sequential scan.
- **The sample follows the table's mix**: 78 INFO, 13 WARN, 8 ERROR, 1 FATAL.
  Recall is measured on realistic traffic, but errors are a minority.
- **The neighbors are easy.** 99.5% of them share the query's `root_cause`,
  mostly near-copies of the same template. That's expected for nearest-neighbor
  search, and it doesn't make recall less valid. It is why relevance needs its
  own eval.
- **10k rows.** The exact scan takes ~0.6s for all 100 queries. Phase 3 scales
  the table up and regenerates this file. The script and checks stay the same.

## `text_queries.json`

60 hand-written searches, 4 per error root cause, typed the way someone on
call would type them. Each has the `root_cause` a good answer is about, and a
`kind`:

- `keyword`: an exact token from the logs (`ENOSPC`, `x509`);
- `mixed`: shares some words with the logs (`redis is down`);
- `paraphrase`: describes the problem without the logs' words
  (`server ran out of RAM and crashed`).

They measure two things: recall against exact search (computed at run time)
and precision@10, the share of the 10 slots filled with a log of the expected
root cause.

## `results/search-<rows>.json`

Output of `pnpm eval:search --truth=<ground truth for that table size>`:
LIKE, full-text (GIN), exact vector, HNSW over an `ef_search` sweep for
several `(m, ef_construction)` builds, and hybrid RRF. Each entry keeps the
`EXPLAIN` plan, which the script checked for the expected index.

pgvector assigns HNSW levels at random, so each build is a different graph.
Up to 100k rows, each config is built 3 times and recall is reported as
mean `[min-max]`.
