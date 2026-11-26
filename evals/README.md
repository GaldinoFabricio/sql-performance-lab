# Evals

## `ground_truth.<size>.json`

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
  `ef_search=40` gives 98.7% recall on log queries but 71% on free text. So
  `pnpm eval:search` also measures recall for `text_queries.json`. Exact
  search is the truth for any query vector, so it computes the exact k-th
  distance for each free-text query with the same forced sequential scan.
- **The sample follows the table's mix**: 78 INFO, 13 WARN, 8 ERROR, 1 FATAL.
  Recall is measured on realistic traffic, but errors are a minority.
- **The neighbors are easy.** 99.5% of them share the query's `root_cause`,
  mostly near-copies of the same template. That's expected for nearest-neighbor
  search, and it doesn't make recall less valid. It is why relevance needs its
  own eval.
- **One file per table size.** `ground_truth.10k.json` is for the default 10k
  rows, and the scripts use it when no path is given. Larger tables get their
  own file, built with the same script and checks:
  `pnpm eval:ground-truth --out=evals/ground_truth.100k.json` after
  `LOGS_COUNT=100000 pnpm seed:logs && pnpm embed:logs`. At 100k, the exact
  scan takes ~5s for the 100 queries and the JS cross-check ~19s.

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

An optional `also` lists other root causes that are just as right when the
query is ambiguous. Only `ECONNREFUSED` has one (`cache_unavailable`): both
the cache and the database clients log it. Added during the reranker work;
result files written before that (`search-*`, `codes-*`, `partial-hnsw-*`,
`hnsw-dive-*`, `rerank-10k-message.json`) used the database label alone.
Every eval decides relevance through `isRelevant` / `relevantCauses`
(`src/evals/metrics.ts`).

## `results/search-<rows>.json`

Output of `pnpm eval:search --truth=<ground truth for that table size>`:
LIKE, full-text (GIN), exact vector, HNSW over an `ef_search` sweep for
several `(m, ef_construction)` builds, and hybrid RRF. Each entry keeps the
`EXPLAIN` plan, which the script checked for the expected index.

pgvector assigns HNSW levels at random, so each build is a different graph.
Up to 100k rows, each config is built 3 times and recall is reported as
mean `[min-max]`.

## `results/hnsw-dive-<rows>.json`

Written by `pnpm eval:hnsw-dive --rebuild=N` (`src/scripts/hnsw-dive.ts`). It
studies the full index (every row). Since migration `20261118120000` the
production index is partial, so the script builds its own full index and
drops it at the end (`--keep-index` keeps it). `eval:search`
compares configs by their averages; this one looks at what HNSW does on the
60 typed queries, with the production index (m = 32, ef_construction = 200):

1. recall (tie-aware, as above) and precision per kind of query, at
   ef_search 40 and 160. `--rebuild=N` drops and rebuilds the index N times
   and reports `mean (min–max)` across builds, to show how much of a
   difference is just a different random graph. The last build stays.
2. a deep dive on up to 4 queries: `EXPLAIN (ANALYZE, BUFFERS)` for exact
   search and HNSW (median time of 5 runs, pages read, plan), and the logs
   HNSW missed next to the ones it returned instead.

The deep dive picks one query of each kind of failure, because they have
different fixes:

| Case | Exact search | HNSW | Who failed | What helps |
| --- | --- | --- | --- | --- |
| index failed | finds relevant logs | loses them | the graph walk | higher `ef_search`, bigger `m` / `ef_construction`, exact search, or a filter first |
| model failed | nothing relevant | nothing relevant (recall 100%) | the embedding | full-text or hybrid; no index setting helps |
| both fine | relevant | relevant | nobody | |

Measured on 100k rows (8 builds, 2026-11-16): exact search read all 26,739
pages in ~33 ms; HNSW at ef_search 160 read ~1,300 in ~1 ms, with tie-aware
recall between 74% and 88% depending on the build.

## `results/templates.json`

Written by `pnpm eval:templates` (`src/scripts/templates-eval.ts`). It needs no
database: it generates 10k, 100k and 1M logs in memory with the seed's
generator and runs two stages over them, `toTemplate` (regex masking) and
`toTemplate` + `TemplateMiner`. For each stage and size:

- `templates`: how many distinct templates came out. The generator has 67.
- `purity_root_cause`: the share of logs whose template's majority
  `root_cause` is their own. 100% means a template never mixes causes.
- `purity_generator_template`: the same against `template_key`, the
  generator's label for the sentence that produced the log (eval only, never
  stored in the table).
- `new_templates_last_10pct`: templates first seen in the last 10% of the
  logs. Near 0 means the set has stopped growing.
- `fragmentation`: for each generator template, how many templates it was
  split into, and `impure_templates`: up to 20 templates that mix root causes.

## `results/search-<rows>-templates.json` and `search-1m-templates-only.json`

`pnpm eval:search` adds a `template (exact over templates)` method whenever
the template tables are current (`templatesCurrent`: the map covers every
log and no embedding is stale; run `pnpm templates:build` first). These files
were run with `--hnsw=32:200 --ef=40,160` and are kept apart from
`search-<rows>.json`, so `pnpm eval:report` ignores them and the main tables
are unchanged.

`--templates-only` measures template mode alone on the 60 free-text queries.
It needs no ground truth and no per-log embeddings, which is how the 1M file
was made without embedding a million rows again.

For template mode, read **precision@10**, not recall: it returns the newest
logs of the nearest templates, not the nearest logs, so its overlap with the
exact top-10 is low by design.

## `results/partial-hnsw-<rows>.json`

Written by `pnpm eval:partial-hnsw` (`src/scripts/partial-hnsw.ts`): the full
HNSW index against a partial one `WHERE level <> 'INFO'`, on the 60 typed
queries. Write-up in [SEMANTIC_SEARCH.md](../SEMANTIC_SEARCH.md#a-partial-hnsw-index-without-info-logs).

- `summary`: one entry per method: exact (all rows / not INFO), full HNSW
  (no filter, filter after the walk, filter with iterative scan) and partial
  HNSW, at ef_search 40 and 160. Each has recall and precision (mean and
  `[min, max]` across builds), `short_results` (queries that got fewer than
  10 rows), `zero_relevant`, p50/p95 latency, index size and build times.
- **Recall truth depends on the filter.** Unfiltered methods are compared
  with the exact top-10 over all rows. Filtered ones (`WHERE level <> 'INFO'`)
  are compared with the exact top-10 over non-INFO rows, since an INFO row is
  never a right answer for them.
- `writes`: WAL bytes and rows/s per INSERT of 500 copied INFO and non-INFO
  rows, with only the full index, only the partial one, or no HNSW index.
  Each case runs in a rolled-back transaction that drops the other indexes.
- `per_query`: recall and precision of every query, per method and build.

Flags: `--rebuild=N` builds of the partial index (default 1),
`--rebuild-full=N` builds of the full one (default: the existing index),
`--skip-full` (the 1M file: building the full index takes ~6 min), `--rounds`,
`--write-rows`, `--keep-index`. If the partial index existed before the run
(it is the production index), its last build stays.

## `code_queries.json`

Written by `pnpm eval:codes --generate` (`src/scripts/codes-eval.ts`), without
a database: it runs the log generator (seed 42, 200k logs, INFO left out) and
takes every `error_code` it emits (38). Each code becomes 3 queries:
`exact` (`ECONNRESET`), `lower` (`econnreset`) and `sentence` ("lots of
ECONNRESET errors since the deploy"), 114 in all. `expected` lists the root
causes the code appears in (only `ECONNREFUSED` has two), `ambiguous` lists
the codes with more than one, and `logs` is how many generated logs carry
the code.

**Relevance here is circular by design.** A relevant result is a log of one
of the code's root causes, so any method that returns the logs carrying the
code scores 100%. That makes the file good at showing which modes *miss*
codes, and useless for choosing how much to trust a code match. For that,
check the hand-labelled `text_queries.json`.

## `results/codes-<rows>.json`

Output of `pnpm eval:codes [--cw=1,2,3]`. The 114 code queries run with the
API defaults (no INFO, ef_search 160, 40 hybrid candidates) in each mode:
vector, hybrid (fixed and routed), hybrid with the error-code list at each
`cw`, full-text, template, and a plain `error_code` lookup as the ceiling.
`summary` has precision per form, `same_code` (the share of results carrying
exactly the typed code), queries with nothing relevant and p50 latency.
`text_queries` runs hybrid with and without the code list on the 60 typed
queries, and lists those that contain a known code. `per_query` also has
`code_in_message`: the share of the code's logs whose message contains the
code as text.

## `results/rerank-<rows>[-<doc>][-tw<w>x<n>].json`

Output of `pnpm eval:rerank` (`src/scripts/rerank-eval.ts`). For each typed
and code query, the first stage runs like the API (hybrid, no INFO,
ef_search 160, `cw` 2; `--tw`/`--tt` add the template list) and the
cross-encoder reorders its top 20 and top 50. `summary` has, per group,
`before` (the first stage's top 10), `after` and `ceiling` (the best any
reordering of the N candidates can do) for each N, how many queries got
better or worse, and the reranker's p50/p95 latency (message fetch +
scoring, median of 3 runs after a warm-up). `per_query` keeps every number
and the top-3 root causes before and after. The file name says what the
reranker read: none = `code`, `-described`, `-template`; `-message` is the
first try (message only, old `ECONNREFUSED` label, hybrid and vector); the
100k first try is `rerank-100k.json` at commit `705a294`.
Within one table size, files measured on the same HNSW build are comparable;
`-template` and `-template-tw*` at 100k share a build, `rerank-100k.json`
and `-described` share another.

`rerank-100k-3builds.json` aggregates three runs on three builds of the
partial HNSW index over the same 100k rows (`REINDEX` between them), for the
`template`, `template` + `tw 1 x 3` and `code` readers: mean, min, max and
the per-build values of every number in `summary`.

## `results/search-<rows>-templates-only[-nodesc].json`

`pnpm eval:search --templates-only` with the templates' embeddings built
with the LLM descriptions (`pnpm templates:build`) and without them
(`-nodesc`, `pnpm templates:build --no-describe`).

## `../data/template-descriptions.json`

Not an eval file, but the evals depend on it: one plain-English description
per log template, keyed by `partition<TAB>template`, written by
`pnpm templates:describe` with `claude -p`. The LLM saw only the template and
one example, never `root_cause` or the eval queries, so the evals don't
measure the labels. Regenerating it changes the numbers; edit by hand only
with a note here.
