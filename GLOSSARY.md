# Semantic search over logs

How the lab measures ways of answering a typed search over a table of logs: what is run, what counts as a right answer, and how results are fused.

## Measuring

**Eval**:
A repeatable script that scores search methods against labelled queries and saves the results.
_Avoid_: Benchmark, test run

**Experiment**:
One numbered question tested by changing a single thing, such as an index setting, a weight or a rerank step. It may run one or more evals.
_Avoid_: Trial, run

**Ground truth**:
The exact top-10 nearest neighbours of a log query, used as the reference for recall.
_Avoid_: Gold set, expected results

**Relevant causes**:
The root causes that count as a right answer to a typed query. Normally one; more when the query is genuinely ambiguous.
_Avoid_: Expected labels, ground truth (for typed queries)

**Mean reciprocal rank (MRR)**:
How early a mode puts a right answer to a typed query. Each query scores 1 divided by the rank of the first result whose root cause is among the relevant causes, or 0 if none appears in the top k; MRR is the mean over the typed queries.
_Avoid_: MRR score, rank score

**Root cause**:
The incident category a seeded log was generated to represent. It exists only to judge results and is never returned to users.
_Avoid_: Label, category, cause

## Queries

**Log query**:
A log row used as the query, to find logs like it.
_Avoid_: Sample query

**Typed query**:
A search phrase written the way an on-call engineer would type it. It is a keyword, mixed or paraphrase query depending on how many words it shares with the logs.
_Avoid_: Free-text query, user query

## Searching

**Mode**:
Which way of answering a search is used: `LIKE`, full-text, vector, template or hybrid.
_Avoid_: Method, strategy

**Hybrid search**:
Full-text and vector candidates fused into one ranking by Reciprocal Rank Fusion. It is the default mode; code lists, template lists and the reranker are add-ons to it, not part of it.
_Avoid_: Combined search, mixed search

**Error code**:
The identifier a log carries, such as `ECONNRESET` or `40P01`, which may never appear in its message text. Found in the query text.
_Avoid_: Error type, status

**Code list**:
The candidates a hybrid search takes from the logs of each error code found in the query: every code's newest log first, then every code's second newest, and so on, so one noisy code can't take every slot.
_Avoid_: Code filter

**Query routing**:
Choosing which side of a hybrid search to favour, full-text or vector, from the shape of the query. It never drops a side: a side that finds nothing (see **Stop-word-only query**) is a result of the query, not a routing decision.
_Avoid_: Mode selection, query classification

**Stop-word-only query**:
A query whose words are all stop words ("the and of"), so it has nothing full-text search can match. In full-text mode the result is empty and the response carries a warning saying why. A hybrid search of it is vector-only, because its full-text side finds nothing.
_Avoid_: Empty query, noise query
