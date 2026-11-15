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

- **Queries come from the corpus.** They are real log lines, not user-typed
  searches like "db connection timeout". That's fine for measuring the index
  (recall); free-text queries belong to the relevance eval.
- **The sample follows the table's mix**: 78 INFO, 13 WARN, 8 ERROR, 1 FATAL.
  Recall is measured on realistic traffic, but errors are a minority.
- **The neighbors are easy.** 99.5% of them share the query's `root_cause`,
  mostly near-copies of the same template. That's expected for nearest-neighbor
  search, and it doesn't make recall less valid. It is why relevance needs its
  own eval.
- **10k rows.** The exact scan takes ~0.6s for all 100 queries. Phase 3 scales
  the table up and regenerates this file. The script and checks stay the same.
