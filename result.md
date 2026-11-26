rODES ESSES COMANDOS

pnpm eval:partial-hnsw --skip-full
pnpm eval:rerank --stages=hybrid --doc=template

ca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:ground-truth --out=evals/ground_truth.1m.json

> sql-performance-lab@1.0.0 eval:ground-truth /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/ground-truth.ts --out=evals/ground_truth.1m.json

[dotenv@17.3.1] injecting env (5) from .env -- tip: ⚙️ suppress all logs with { quiet: true }
1,000,000 rows, 100 sampled queries (seed 42)
exact search (seq scan): 100 queries in 57.21s
cross-check: Postgres == JS float64 brute force for all 100 queries (156.4s, eps=0.00001)

wrote evals/ground_truth.1m.json
queries by level: INFO 72, ERROR 15, WARN 11, FATAL 2
ties at the k-th distance: 50/100 queries (max 36686 extra rows)
neighbors with the query's root_cause: 100.0%
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$

hybrid routed 77.8% [77.8-77.8] 89.2% [89.2-89.2] 70.0% [70.0-70.0] 70.6% [70.6-70.6]

router: 18 of 60 queries classified as identifier (keyword 12, mixed 5, paraphrase 1)

routed - fixed, paired per build (points of precision):
all +2.3 [+2.3 to +2.3] noise 0.0 → ABOVE the noise
keyword +8.3 [+8.3 to +8.3] noise 0.0 → ABOVE the noise
mixed -11.6 [-11.6 to -11.6] noise 0.0 → ABOVE the noise
paraphrase +9.4 [+9.4 to +9.4] noise 0.0 → ABOVE the noise
(one query changing one of its 10 results moves a group of n queries by 10/n points)

routing made precision WORSE on 11 queries (better on 15, same on 34):
50.0% → 0.0% (worse on 1/1 builds) [mixed, natural] redis is down
100.0% → 50.0% (worse on 1/1 builds) [keyword, natural] no space left on device
50.0% → 0.0% (worse on 1/1 builds) [mixed, natural] hostname lookup failing
50.0% → 0.0% (worse on 1/1 builds) [mixed, natural] accessing a property of an undefined object
50.0% → 0.0% (worse on 1/1 builds) [keyword, natural] OOMKilled
50.0% → 0.0% (worse on 1/1 builds) [mixed, natural] backlog keeps growing
50.0% → 0.0% (worse on 1/1 builds) [paraphrase, natural] emails are being sent hours late
50.0% → 0.0% (worse on 1/1 builds) [keyword, natural] statement timeout
50.0% → 0.0% (worse on 1/1 builds) [mixed, natural] query is too slow
70.0% → 30.0% (worse on 1/1 builds) [mixed, identifier] HTTPS certificate is no longer valid
20.0% → 0.0% (worse on 1/1 builds) [paraphrase, natural] orders page takes forever to load from the database

wrote evals/results/search-1m.json
recreating idx_logs_embedding_hnsw...

Com 10 milhoes

srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ LOGS_COUNT=10000 pnpm seed:logs && pnpm embed:logs

> sql-performance-lab@1.0.0 seed:logs /home/srcareca/Documentos/node/sql-performance-lab
> knex --knexfile src/knexfile.ts seed:run --specific=seed_logs.ts

Requiring external module ts-node/register
Working directory changed to ~/Documentos/node/sql-performance-lab/src
[dotenv@17.3.1] injecting env (5) from ../.env -- tip: ⚙️ suppress all logs with { quiet: true }
seed_logs: 10,000 logs (seed=42) in 0.8s (11,839 rows/s)
Ran 1 seed files

> sql-performance-lab@1.0.0 embed:logs /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/embed-logs.ts

[dotenv@17.3.1] injecting env (5) from .env -- tip: 🛠️ run anywhere with `dotenvx run -- yourcommand`
Xenova/all-MiniLM-L6-v2: 0/10,000 already embedded, 10,000 to go (batch=256)
1,536/10,000 (15.4%) 146 rows/s now, 146 avg, ETA 58s
3,072/10,000 (30.7%) 129 rows/s now, 137 avg, ETA 50s
4,608/10,000 (46.1%) 142 rows/s now, 139 avg, ETA 39s
6,144/10,000 (61.4%) 128 rows/s now, 136 avg, ETA 28s
7,680/10,000 (76.8%) 143 rows/s now, 137 avg, ETA 17s
9,216/10,000 (92.2%) 124 rows/s now, 135 avg, ETA 6s

embedded 10,000 rows in 1.2min: 136 rows/s (model 55%, database 45% of the time)
before VACUUM: 10,000 live, 4,096 dead tuples, 47 MB
after VACUUM: 10,000 live, 0 dead tuples, 47 MB
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:ground-truth --out=evals/ground_truth.1m.json

> sql-performance-lab@1.0.0 eval:ground-truth /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/ground-truth.ts --out=evals/ground_truth.1m.json

[dotenv@17.3.1] injecting env (5) from .env -- tip: ⚙️ override existing env vars with { override: true }
10,000 rows, 100 sampled queries (seed 42)
exact search (seq scan): 100 queries in 0.55s
cross-check: Postgres == JS float64 brute force for all 100 queries (1.7s, eps=0.00001)

wrote evals/ground_truth.1m.json
queries by level: INFO 78, WARN 13, ERROR 8, FATAL 1
ties at the k-th distance: 19/100 queries (max 391 extra rows)
neighbors with the query's root_cause: 99.5%
srcareca@srcareca-System-Product-Name:~/Documentos/node

srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:search --truth=evals/ground_truth.1m.json

> sql-performance-lab@1.0.0 eval:search /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/search-experiments.ts --truth=evals/ground_truth.1m.json

[dotenv@17.3.1] injecting env (5) from .env -- tip: ⚙️ suppress all logs with { quiet: true }
dropping idx_logs_embedding_hnsw for the run; it is recreated at the end:
CREATE INDEX idx_logs_embedding_hnsw ON public.logs USING hnsw (embedding vector_cosine_ops) WITH (m='32', ef_construction='200')
10,000 rows, 100 log queries, k=10, 3 measured rounds
skipping template search: run pnpm templates:build to include it
running LIKE (no index)... done
running full-text (GIN)... done
running vector exact (seq)... done
building HNSW (m=16 efc=64) 1/3... 0.5s, 16.1 MB
HNSW m=16 efc=64 ef_search=10... done
HNSW m=16 efc=64 ef_search=20... done
HNSW m=16 efc=64 ef_search=40... done
HNSW m=16 efc=64 ef_search=80... done
HNSW m=16 efc=64 ef_search=160... done
hybrid RRF (m=16 efc=64 ef=40)... done
hybrid routed (m=16 efc=64 ef=40)... done
building HNSW (m=16 efc=64) 2/3... 0.7s, 16.2 MB
HNSW m=16 efc=64 ef_search=10... done
HNSW m=16 efc=64 ef_search=20... done
HNSW m=16 efc=64 ef_search=40... done
HNSW m=16 efc=64 ef_search=80... done
HNSW m=16 efc=64 ef_search=160... done
hybrid RRF (m=16 efc=64 ef=40)... done
hybrid routed (m=16 efc=64 ef=40)... done
building HNSW (m=16 efc=64) 3/3... 0.5s, 16.2 MB
HNSW m=16 efc=64 ef_search=10... done
HNSW m=16 efc=64 ef_search=20... done
HNSW m=16 efc=64 ef_search=40... done
HNSW m=16 efc=64 ef_search=80... done
HNSW m=16 efc=64 ef_search=160... done
hybrid RRF (m=16 efc=64 ef=40)... done
hybrid routed (m=16 efc=64 ef=40)... done
building HNSW (m=16 efc=200) 1/3... 1.0s, 16.1 MB
HNSW m=16 efc=200 ef_search=10... done
HNSW m=16 efc=200 ef_search=20... done
HNSW m=16 efc=200 ef_search=40... done
HNSW m=16 efc=200 ef_search=80... done
HNSW m=16 efc=200 ef_search=160... done
hybrid RRF (m=16 efc=200 ef=40)... done
hybrid routed (m=16 efc=200 ef=40)... done
building HNSW (m=16 efc=200) 2/3... 1.4s, 16.1 MB
HNSW m=16 efc=200 ef_search=10... done
HNSW m=16 efc=200 ef_search=20... done
HNSW m=16 efc=200 ef_search=40... done
HNSW m=16 efc=200 ef_search=80... done
HNSW m=16 efc=200 ef_search=160... done
hybrid RRF (m=16 efc=200 ef=40)... done
hybrid routed (m=16 efc=200 ef=40)... done
building HNSW (m=16 efc=200) 3/3... 0.9s, 16.1 MB
HNSW m=16 efc=200 ef_search=10... done
HNSW m=16 efc=200 ef_search=20... done
HNSW m=16 efc=200 ef_search=40... done
HNSW m=16 efc=200 ef_search=80... done
HNSW m=16 efc=200 ef_search=160... done
hybrid RRF (m=16 efc=200 ef=40)... done
hybrid routed (m=16 efc=200 ef=40)... done
building HNSW (m=32 efc=200) 1/3... 2.0s, 16.6 MB
HNSW m=32 efc=200 ef_search=10... done
HNSW m=32 efc=200 ef_search=20... done
HNSW m=32 efc=200 ef_search=40... done
HNSW m=32 efc=200 ef_search=80... done
HNSW m=32 efc=200 ef_search=160... done
hybrid RRF (m=32 efc=200 ef=40)... done
hybrid routed (m=32 efc=200 ef=40)... done
building HNSW (m=32 efc=200) 2/3... 1.8s, 16.6 MB
HNSW m=32 efc=200 ef_search=10... done
HNSW m=32 efc=200 ef_search=20... done
HNSW m=32 efc=200 ef_search=40... done
HNSW m=32 efc=200 ef_search=80... done
HNSW m=32 efc=200 ef_search=160... done
hybrid RRF (m=32 efc=200 ef=40)... done
hybrid routed (m=32 efc=200 ef=40)... done
building HNSW (m=32 efc=200) 3/3... 2.0s, 16.6 MB
HNSW m=32 efc=200 ef_search=10... done
HNSW m=32 efc=200 ef_search=20... done
HNSW m=32 efc=200 ef_search=40... done
HNSW m=32 efc=200 ef_search=80... done
HNSW m=32 efc=200 ef_search=160... done
hybrid RRF (m=32 efc=200 ef=40)... done
hybrid routed (m=32 efc=200 ef=40)... done

LOG QUERIES (100 logs from the ground truth; recall vs exact search)
method recall@10 [min-max] prec@10 p50 ms p95 ms avg n empty
LIKE (no index) 19.2% 87.4% 1.95 14.2 8.7 12
full-text (GIN) 28.9% 100.0% 24.0 173 10.0 0
vector exact (seq) 100.0% 99.5% 5.17 5.81 10.0 0
HNSW m=16 efc=64 ef_search=10 91.0% [90-92] 90.8% 0.57 1.94 9.4 0
HNSW m=16 efc=64 ef_search=20 98.0% [96-99] 97.9% 0.51 0.76 10.0 0
HNSW m=16 efc=64 ef_search=40 98.4% [96-100] 98.3% 0.53 0.65 10.0 0
HNSW m=16 efc=64 ef_search=80 99.0% [97-100] 98.9% 0.66 0.99 10.0 0
HNSW m=16 efc=64 ef_search=160 100.0% [100-100] 99.5% 0.80 1.08 10.0 0
hybrid RRF (m=16 efc=64 ef=40) 55.7% [55-56] 98.7% 25.1 172 10.0 0
hybrid routed (m=16 efc=64 ef=40) 43.9% [44-44] 99.6% 25.1 169 10.0 0
HNSW m=16 efc=200 ef_search=10 93.0% [92-93] 92.5% 0.49 1.79 9.3 0
HNSW m=16 efc=200 ef_search=20 100.0% [100-100] 99.5% 0.47 0.61 10.0 0
HNSW m=16 efc=200 ef_search=40 100.0% [100-100] 99.5% 0.50 0.63 10.0 0
HNSW m=16 efc=200 ef_search=80 100.0% [100-100] 99.5% 0.61 0.81 10.0 0
HNSW m=16 efc=200 ef_search=160 100.0% [100-100] 99.5% 0.77 0.98 10.0 0
hybrid RRF (m=16 efc=200 ef=40) 56.2% [56-56] 99.3% 25.3 170 10.0 0
hybrid routed (m=16 efc=200 ef=40) 44.1% [44-44] 99.6% 25.5 171 10.0 0
HNSW m=32 efc=200 ef_search=10 93.3% [93-93] 92.8% 0.83 1.30 9.3 0
HNSW m=32 efc=200 ef_search=20 100.0% [100-100] 99.5% 0.51 0.65 10.0 0
HNSW m=32 efc=200 ef_search=40 100.0% [100-100] 99.5% 0.56 0.77 10.0 0
HNSW m=32 efc=200 ef_search=80 100.0% [100-100] 99.5% 0.84 1.37 10.0 0
HNSW m=32 efc=200 ef_search=160 100.0% [100-100] 99.5% 0.98 1.37 10.0 0
hybrid RRF (m=32 efc=200 ef=40) 56.2% [56-56] 99.3% 25.5 170 10.0 0
hybrid routed (m=32 efc=200 ef=40) 44.1% [44-44] 99.6% 25.0 171 10.0 0

FREE-TEXT QUERIES (60, evals/text_queries.json; recall vs exact, precision by root_cause)
method recall@10 [min-max] prec@10 p50 ms p95 ms avg n empty
LIKE (no index) 14.5% 35.0% 13.4 15.4 3.5 39
full-text (GIN) 25.3% 80.0% 3.82 13.8 9.7 2
vector exact (seq) 100.0% 92.0% 5.75 6.28 10.0 0
HNSW m=16 efc=64 ef_search=10 67.3% [57-80] 64.5% 0.51 0.79 10.0 0
HNSW m=16 efc=64 ef_search=20 74.3% [66-85] 70.6% 0.53 0.70 10.0 0
HNSW m=16 efc=64 ef_search=40 80.8% [77-86] 75.9% 0.56 0.77 10.0 0
HNSW m=16 efc=64 ef_search=80 86.6% [84-89] 81.5% 0.68 1.08 10.0 0
HNSW m=16 efc=64 ef_search=160 88.1% [87-89] 82.3% 0.94 1.44 10.0 0
hybrid RRF (m=16 efc=64 ef=40) 49.3% [47-52] 81.7% 5.05 15.4 10.0 0
hybrid routed (m=16 efc=64 ef=40) 56.9% [54-61] 82.6% 5.14 14.9 10.0 0
HNSW m=16 efc=200 ef_search=10 78.7% [72-88] 75.7% 0.48 0.65 10.0 0
HNSW m=16 efc=200 ef_search=20 81.4% [76-90] 77.3% 0.49 0.65 10.0 0
HNSW m=16 efc=200 ef_search=40 85.3% [79-94] 80.6% 0.63 1.02 10.0 0
HNSW m=16 efc=200 ef_search=80 92.8% [89-96] 85.6% 0.71 1.52 10.0 0
HNSW m=16 efc=200 ef_search=160 92.8% [89-96] 85.6% 0.90 1.18 10.0 0
hybrid RRF (m=16 efc=200 ef=40) 51.8% [49-55] 84.9% 5.22 15.7 10.0 0
hybrid routed (m=16 efc=200 ef=40) 61.3% [59-64] 87.8% 5.17 15.6 10.0 0
HNSW m=32 efc=200 ef_search=10 81.3% [75-89] 77.3% 0.49 0.64 10.0 0
HNSW m=32 efc=200 ef_search=20 84.4% [78-91] 77.9% 0.55 0.72 10.0 0
HNSW m=32 efc=200 ef_search=40 89.4% [88-93] 82.8% 0.67 0.93 10.0 0
HNSW m=32 efc=200 ef_search=80 93.9% [91-96] 86.7% 0.99 1.90 10.0 0
HNSW m=32 efc=200 ef_search=160 95.6% [95-96] 88.3% 1.02 1.44 10.0 0
hybrid RRF (m=32 efc=200 ef=40) 53.4% [53-54] 86.4% 5.03 14.5 10.0 0
hybrid routed (m=32 efc=200 ef=40) 62.6% [60-64] 90.0% 5.52 15.7 10.0 0

HNSW builds (maintenance_work_mem 64 MB, 3 parallel workers):
m=16 efc=64 #1: 0.5s, 16.1 MB
m=16 efc=64 #2: 0.7s, 16.2 MB
m=16 efc=64 #3: 0.5s, 16.2 MB
m=16 efc=200 #1: 1.0s, 16.1 MB
m=16 efc=200 #2: 1.4s, 16.1 MB
m=16 efc=200 #3: 0.9s, 16.1 MB
m=32 efc=200 #1: 2.0s, 16.6 MB
m=32 efc=200 #2: 1.8s, 16.6 MB
m=32 efc=200 #3: 2.0s, 16.6 MB
(table heap 20.0 MB, GIN 4.6 MB)

embedding a free-text query: p50 1.69 ms (Xenova/all-MiniLM-L6-v2, CPU)

free-text precision@10 by kind (vector/hybrid: m=32 efc=200 ef_search=40):
kind n LIKE fts exact hnsw hybrid
keyword 24 83.3% 91.3% 91.3% 74.9% 85.1%
mixed 19 5.3% 94.2% 99.5% 93.0% 95.4%
paraphrase 17 0.0% 48.2% 84.7% 82.7% 78.2%

where each one wins (precision@10, free text):
keywords fts 100.0% exact-vector 0.0% hybrid 50.0% [keyword] ECONNRESET
vectors fts 50.0% exact-vector 100.0% hybrid 96.7% [paraphrase] session store unreachable
vectors fts 30.0% exact-vector 100.0% hybrid 100.0% [paraphrase] storage volume is full
vectors fts 20.0% exact-vector 100.0% hybrid 100.0% [paraphrase] same order submitted twice
vectors fts 0.0% exact-vector 100.0% hybrid 100.0% [keyword] NullPointerException
vectors fts 0.0% exact-vector 100.0% hybrid 50.0% [paraphrase] code crashed on a missing field
vectors fts 0.0% exact-vector 100.0% hybrid 100.0% [paraphrase] server ran out of RAM and crashed
vectors fts 0.0% exact-vector 100.0% hybrid 60.0% [paraphrase] customers cannot pay, card processor is down
vectors fts 0.0% exact-vector 100.0% hybrid 16.7% [keyword] too many requests
vectors fts 10.0% exact-vector 100.0% hybrid 80.0% [paraphrase] we sold more items than we have in the warehouse
keywords fts 100.0% exact-vector 0.0% hybrid 50.0% [keyword] x509
vectors fts 30.0% exact-vector 100.0% hybrid 80.0% [mixed] HTTPS certificate is no longer valid

ROUTING: free-text precision@10, mean [min-max across 3 HNSW builds]
method all (n=60) keyword (n=24) mixed (n=19) paraphrase (n=17)  
fts 80.0% [80.0-80.0] 91.3% [91.3-91.3] 94.2% [94.2-94.2] 48.2% [48.2-48.2]  
vector exact 92.0% [92.0-92.0] 91.3% [91.3-91.3] 99.5% [99.5-99.5] 84.7% [84.7-84.7]  
hnsw 82.8% [80.7-85.7] 74.9% [66.7-79.2] 93.0% [89.5-94.7] 82.7% [78.8-84.7]  
hybrid fixed 86.4% [85.3-87.8] 85.1% [80.8-87.5] 95.4% [93.7-96.3] 78.2% [75.9-79.4]  
hybrid routed 90.0% [86.7-93.3] 91.7% [83.3-95.8] 94.9% [93.2-98.4] 82.2% [78.2-84.1]

router: 18 of 60 queries classified as identifier (keyword 12, mixed 5, paraphrase 1)

routed - fixed, paired per build (points of precision):
all +3.6 [+1.3 to +5.5] noise 6.7 → within the noise
keyword +6.5 [+2.5 to +8.8] noise 12.5 → within the noise
mixed -0.5 [-3.2 to +2.1] noise 5.3 → within the noise
paraphrase +3.9 [+2.4 to +4.7] noise 5.9 → within the noise
(one query changing one of its 10 results moves a group of n queries by 10/n points)

routing made precision WORSE on 7 queries (better on 11, same on 42):
66.7% → 33.3% (worse on 2/3 builds) [mixed, natural] redis is down
70.0% → 40.0% (worse on 3/3 builds) [paraphrase, natural] emails are being sent hours late
60.0% → 33.3% (worse on 2/3 builds) [keyword, natural] temporary failure in name resolution
83.3% → 66.7% (worse on 1/3 builds) [paraphrase, natural] cannot write files anymore, the drive is at capacity
83.3% → 66.7% (worse on 1/3 builds) [keyword, natural] duplicate key value violates unique constraint
83.3% → 66.7% (worse on 1/3 builds) [keyword, natural] kafka consumer lag
80.0% → 70.0% (worse on 3/3 builds) [mixed, identifier] HTTPS certificate is no longer valid

wrote evals/results/search-10k.json
recreating idx_logs_embedding_hnsw...
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:partial-hnsw --skip-full

> sql-performance-lab@1.0.0 eval:partial-hnsw /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/partial-hnsw.ts --skip-full

[dotenv@17.3.1] injecting env (5) from .env -- tip: 🤖 agentic secret storage: https://dotenvx.com/as2
logs: 10.000 rows, 2.639 not INFO (26.4%); HNSW m=32 ef_construction=200, top-10

partial index build 1: 0.6 s

method recall@10 precision@10 <10 rows 0 relevant p50 ms p95 ms
exact, all rows 100.0% 92.0% 0 4 7.36 7.89
exact, not INFO 100.0% 94.8% 0 3 4.99 5.05
partial HNSW, ef_search=40 98.3% 93.3% 0 4 1.20 1.38
partial HNSW, ef_search=160 100.0% 94.8% 0 3 1.80 2.04

precision by kind:
exact, all rows keyword 91.3% mixed 99.5% paraphrase 84.7%
exact, not INFO keyword 91.3% mixed 100.0% paraphrase 94.1%
partial HNSW, ef_search=40 keyword 87.5% mixed 100.0% paraphrase 94.1%
partial HNSW, ef_search=160 keyword 91.3% mixed 100.0% paraphrase 94.1%

index: full skipped; partial 4.3 MB, built in 0.6s

INSERT of 500 copied rows (rolled back):
no HNSW INFO: 2.157 B WAL/row, 54.177 rows/s not INFO: 2.363 B WAL/row, 37.129 rows/s  
 partial only INFO: 2.160 B WAL/row, 53.679 rows/s not INFO: 3.277 B WAL/row, 1.188 rows/s

wrote evals/results/partial-hnsw-10k.json (kept idx_logs_embedding_hnsw_not_info)
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:rerank --stages=hybrid --doc=template

> sql-performance-lab@1.0.0 eval:rerank /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/rerank-eval.ts --stages=hybrid --doc=template

[dotenv@17.3.1] injecting env (5) from .env -- tip: 🔐 prevent committing .env to code: https://dotenvx.com/precommit
Error: --doc=described needs current templates: run pnpm templates:build
at run (/home/srcareca/Documentos/node/sql-performance-lab/src/scripts/rerank-eval.ts:86:102)
at processTicksAndRejections (node:internal/process/task_queues:103:5)
 ELIFECYCLE  Command failed with exit code 1.
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:search --truth=evals/ground_truth.10k.json

> sql-performance-lab@1.0.0 eval:search /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/search-experiments.ts --truth=evals/ground_truth.10k.json

[dotenv@17.3.1] injecting env (5) from .env -- tip: 🔐 prevent building .env in docker: https://dotenvx.com/prebuild
dropping idx_logs_embedding_hnsw for the run; it is recreated at the end:
CREATE INDEX idx_logs_embedding_hnsw ON public.logs USING hnsw (embedding vector_cosine_ops) WITH (m='32', ef_construction='200')
10,000 rows, 100 log queries, k=10, 3 measured rounds
running LIKE (no index)... done
running full-text (GIN)... done
running vector exact (seq)... done
running template (exact over templates)... done
building HNSW (m=16 efc=64) 1/3... 0.5s, 16.1 MB
HNSW m=16 efc=64 ef_search=10... done
HNSW m=16 efc=64 ef_search=20... done
HNSW m=16 efc=64 ef_search=40... done
HNSW m=16 efc=64 ef_search=80... done
HNSW m=16 efc=64 ef_search=160... done
hybrid RRF (m=16 efc=64 ef=40)... done
hybrid routed (m=16 efc=64 ef=40)... done
building HNSW (m=16 efc=64) 2/3... 0.7s, 16.1 MB
HNSW m=16 efc=64 ef_search=10... done
HNSW m=16 efc=64 ef_search=20... done
HNSW m=16 efc=64 ef_search=40... done
HNSW m=16 efc=64 ef_search=80... done
HNSW m=16 efc=64 ef_search=160... done
hybrid RRF (m=16 efc=64 ef=40)... done
hybrid routed (m=16 efc=64 ef=40)... done
building HNSW (m=16 efc=64) 3/3... 0.5s, 16.1 MB
HNSW m=16 efc=64 ef_search=10... done
HNSW m=16 efc=64 ef_search=20... done
HNSW m=16 efc=64 ef_search=40... done
HNSW m=16 efc=64 ef_search=80... done
HNSW m=16 efc=64 ef_search=160... done
hybrid RRF (m=16 efc=64 ef=40)... done
hybrid routed (m=16 efc=64 ef=40)... done
building HNSW (m=16 efc=200) 1/3... 1.4s, 16.1 MB
HNSW m=16 efc=200 ef_search=10... done
HNSW m=16 efc=200 ef_search=20... done
HNSW m=16 efc=200 ef_search=40... done
HNSW m=16 efc=200 ef_search=80... done
HNSW m=16 efc=200 ef_search=160... done
hybrid RRF (m=16 efc=200 ef=40)... done
hybrid routed (m=16 efc=200 ef=40)... done
building HNSW (m=16 efc=200) 2/3... 0.9s, 16.1 MB
HNSW m=16 efc=200 ef_search=10... done
HNSW m=16 efc=200 ef_search=20... done
HNSW m=16 efc=200 ef_search=40... done
HNSW m=16 efc=200 ef_search=80... done
HNSW m=16 efc=200 ef_search=160... done
hybrid RRF (m=16 efc=200 ef=40)... done
hybrid routed (m=16 efc=200 ef=40)... done
building HNSW (m=16 efc=200) 3/3... 1.5s, 16.1 MB
HNSW m=16 efc=200 ef_search=10... done
HNSW m=16 efc=200 ef_search=20... done
HNSW m=16 efc=200 ef_search=40... done
HNSW m=16 efc=200 ef_search=80... done
HNSW m=16 efc=200 ef_search=160... done
hybrid RRF (m=16 efc=200 ef=40)... done
hybrid routed (m=16 efc=200 ef=40)... done
building HNSW (m=32 efc=200) 1/3... 2.1s, 16.6 MB
HNSW m=32 efc=200 ef_search=10... done
HNSW m=32 efc=200 ef_search=20... done
HNSW m=32 efc=200 ef_search=40... done
HNSW m=32 efc=200 ef_search=80... done
HNSW m=32 efc=200 ef_search=160... done
hybrid RRF (m=32 efc=200 ef=40)... done
hybrid routed (m=32 efc=200 ef=40)... done
building HNSW (m=32 efc=200) 2/3... 2.0s, 16.6 MB
HNSW m=32 efc=200 ef_search=10... done
HNSW m=32 efc=200 ef_search=20... done
HNSW m=32 efc=200 ef_search=40... done
HNSW m=32 efc=200 ef_search=80... done
HNSW m=32 efc=200 ef_search=160... done
hybrid RRF (m=32 efc=200 ef=40)... done
hybrid routed (m=32 efc=200 ef=40)... done
building HNSW (m=32 efc=200) 3/3... 1.9s, 16.6 MB
HNSW m=32 efc=200 ef_search=10... done
HNSW m=32 efc=200 ef_search=20... done
HNSW m=32 efc=200 ef_search=40... done
HNSW m=32 efc=200 ef_search=80... done
HNSW m=32 efc=200 ef_search=160... done
hybrid RRF (m=32 efc=200 ef=40)... done
hybrid routed (m=32 efc=200 ef=40)... done

LOG QUERIES (100 logs from the ground truth; recall vs exact search)
method recall@10 [min-max] prec@10 p50 ms p95 ms avg n empty
LIKE (no index) 19.2% 87.4% 2.15 15.1 8.7 12
full-text (GIN) 28.9% 100.0% 23.8 166 10.0 0
vector exact (seq) 100.0% 99.5% 5.31 5.60 10.0 0
template (exact over templates) 11.3% 91.0% 0.93 1.22 10.0 0
HNSW m=16 efc=64 ef_search=10 90.0% [88-92] 90.8% 0.56 1.40 9.4 0
HNSW m=16 efc=64 ef_search=20 96.7% [95-98] 97.4% 0.50 0.70 10.0 0
HNSW m=16 efc=64 ef_search=40 98.7% [98-100] 98.7% 0.52 0.63 10.0 0
HNSW m=16 efc=64 ef_search=80 99.7% [99-100] 99.2% 0.60 0.78 10.0 0
HNSW m=16 efc=64 ef_search=160 99.7% [99-100] 99.2% 0.79 1.11 10.0 0
hybrid RRF (m=16 efc=64 ef=40) 55.8% [55-56] 99.0% 24.5 174 10.0 0
hybrid routed (m=16 efc=64 ef=40) 43.9% [44-44] 99.7% 24.4 175 10.0 0
HNSW m=16 efc=200 ef_search=10 92.6% [92-93] 92.5% 0.51 0.73 9.3 0
HNSW m=16 efc=200 ef_search=20 100.0% [100-100] 99.5% 0.47 0.60 10.0 0
HNSW m=16 efc=200 ef_search=40 100.0% [100-100] 99.5% 0.48 0.60 10.0 0
HNSW m=16 efc=200 ef_search=80 100.0% [100-100] 99.5% 0.59 0.78 10.0 0
HNSW m=16 efc=200 ef_search=160 100.0% [100-100] 99.5% 0.76 1.17 10.0 0
hybrid RRF (m=16 efc=200 ef=40) 56.2% [56-56] 99.3% 24.3 173 10.0 0
hybrid routed (m=16 efc=200 ef=40) 44.1% [44-44] 99.6% 24.6 173 10.0 0
HNSW m=32 efc=200 ef_search=10 93.0% [92-93] 92.5% 0.50 0.86 9.3 0
HNSW m=32 efc=200 ef_search=20 99.7% [99-100] 99.2% 0.57 0.90 10.0 0
HNSW m=32 efc=200 ef_search=40 100.0% [100-100] 99.5% 0.62 1.07 10.0 0
HNSW m=32 efc=200 ef_search=80 100.0% [100-100] 99.5% 0.71 1.04 10.0 0
HNSW m=32 efc=200 ef_search=160 100.0% [100-100] 99.5% 0.91 1.22 10.0 0
hybrid RRF (m=32 efc=200 ef=40) 56.2% [56-56] 99.3% 24.6 170 10.0 0
hybrid routed (m=32 efc=200 ef=40) 44.1% [44-44] 99.6% 24.3 169 10.0 0

FREE-TEXT QUERIES (60, evals/text_queries.json; recall vs exact, precision by root_cause)
method recall@10 [min-max] prec@10 p50 ms p95 ms avg n empty
LIKE (no index) 14.5% 35.0% 13.6 15.4 3.5 39
full-text (GIN) 25.3% 80.0% 3.89 13.7 9.7 2
vector exact (seq) 100.0% 92.0% 5.58 5.89 10.0 0
template (exact over templates) 33.3% 98.3% 0.83 1.03 10.0 0
HNSW m=16 efc=64 ef_search=10 53.2% [47-61] 53.1% 0.50 0.66 10.0 0
HNSW m=16 efc=64 ef_search=20 66.7% [64-72] 64.7% 0.51 0.77 10.0 0
HNSW m=16 efc=64 ef_search=40 71.1% [67-76] 68.0% 0.57 0.76 10.0 0
HNSW m=16 efc=64 ef_search=80 80.6% [77-84] 76.9% 0.68 1.07 10.0 0
HNSW m=16 efc=64 ef_search=160 86.8% [82-92] 81.6% 1.02 1.49 10.0 0
hybrid RRF (m=16 efc=64 ef=40) 45.3% [45-46] 77.3% 5.05 15.0 10.0 0
hybrid routed (m=16 efc=64 ef=40) 53.0% [51-55] 76.8% 5.05 14.9 10.0 0
HNSW m=16 efc=200 ef_search=10 82.6% [81-84] 80.1% 0.46 0.61 10.0 0
HNSW m=16 efc=200 ef_search=20 85.3% [81-89] 81.8% 0.50 0.61 10.0 0
HNSW m=16 efc=200 ef_search=40 90.1% [87-93] 85.1% 0.55 0.73 10.0 0
HNSW m=16 efc=200 ef_search=80 93.6% [93-95] 86.7% 0.69 1.54 10.0 0
HNSW m=16 efc=200 ef_search=160 94.6% [93-96] 87.2% 0.90 1.28 10.0 0
hybrid RRF (m=16 efc=200 ef=40) 53.4% [52-54] 87.1% 5.11 15.1 10.0 0
hybrid routed (m=16 efc=200 ef=40) 62.7% [62-64] 91.1% 4.95 14.7 10.0 0
HNSW m=32 efc=200 ef_search=10 84.1% [81-87] 79.5% 0.57 0.91 10.0 0
HNSW m=32 efc=200 ef_search=20 87.1% [86-89] 81.2% 0.63 0.98 10.0 0
HNSW m=32 efc=200 ef_search=40 90.4% [89-91] 84.5% 0.67 0.96 10.0 0
HNSW m=32 efc=200 ef_search=80 96.2% [93-98] 88.8% 0.82 1.74 10.0 0
HNSW m=32 efc=200 ef_search=160 96.8% [95-98] 89.3% 1.09 1.45 10.0 0
hybrid RRF (m=32 efc=200 ef=40) 53.8% [53-54] 87.2% 5.11 15.4 10.0 0
hybrid routed (m=32 efc=200 ef=40) 63.3% [63-63] 90.0% 5.34 15.6 10.0 0

HNSW builds (maintenance_work_mem 64 MB, 3 parallel workers):
m=16 efc=64 #1: 0.5s, 16.1 MB
m=16 efc=64 #2: 0.7s, 16.1 MB
m=16 efc=64 #3: 0.5s, 16.1 MB
m=16 efc=200 #1: 1.4s, 16.1 MB
m=16 efc=200 #2: 0.9s, 16.1 MB
m=16 efc=200 #3: 1.5s, 16.1 MB
m=32 efc=200 #1: 2.1s, 16.6 MB
m=32 efc=200 #2: 2.0s, 16.6 MB
m=32 efc=200 #3: 1.9s, 16.6 MB
(table heap 20.0 MB, GIN 4.6 MB)

embedding a free-text query: p50 1.66 ms (Xenova/all-MiniLM-L6-v2, CPU)

free-text precision@10 by kind (vector/hybrid: m=32 efc=200 ef_search=40):
kind n LIKE fts exact hnsw hybrid template
keyword 24 83.3% 91.3% 91.3% 76.4% 86.0% 100.0%
mixed 19 5.3% 94.2% 99.5% 94.6% 96.3% 100.0%
paraphrase 17 0.0% 48.2% 84.7% 84.7% 78.6% 94.1%

where each one wins (precision@10, free text):
keywords fts 100.0% exact-vector 0.0% hybrid 50.0% [keyword] ECONNRESET
vectors fts 50.0% exact-vector 100.0% hybrid 86.7% [paraphrase] session store unreachable
vectors fts 30.0% exact-vector 100.0% hybrid 100.0% [paraphrase] storage volume is full
vectors fts 20.0% exact-vector 100.0% hybrid 100.0% [paraphrase] same order submitted twice
vectors fts 0.0% exact-vector 100.0% hybrid 100.0% [keyword] NullPointerException
vectors fts 0.0% exact-vector 100.0% hybrid 50.0% [paraphrase] code crashed on a missing field
vectors fts 0.0% exact-vector 100.0% hybrid 100.0% [paraphrase] server ran out of RAM and crashed
vectors fts 0.0% exact-vector 100.0% hybrid 60.0% [paraphrase] customers cannot pay, card processor is down
vectors fts 0.0% exact-vector 100.0% hybrid 16.7% [keyword] too many requests
vectors fts 10.0% exact-vector 100.0% hybrid 80.0% [paraphrase] we sold more items than we have in the warehouse
keywords fts 100.0% exact-vector 0.0% hybrid 50.0% [keyword] x509
vectors fts 30.0% exact-vector 100.0% hybrid 80.0% [mixed] HTTPS certificate is no longer valid

ROUTING: free-text precision@10, mean [min-max across 3 HNSW builds]
method all (n=60) keyword (n=24) mixed (n=19) paraphrase (n=17)  
fts 80.0% [80.0-80.0] 91.3% [91.3-91.3] 94.2% [94.2-94.2] 48.2% [48.2-48.2]  
vector exact 92.0% [92.0-92.0] 91.3% [91.3-91.3] 99.5% [99.5-99.5] 84.7% [84.7-84.7]  
hnsw 84.5% [83.8-85.7] 76.4% [75.0-79.2] 94.6% [94.2-94.7] 84.7% [84.7-84.7]  
hybrid fixed 87.2% [86.8-87.7] 86.0% [85.0-87.5] 96.3% [96.3-96.3] 78.6% [78.2-79.4]  
hybrid routed 90.0% [90.0-90.0] 91.7% [91.7-91.7] 93.2% [93.2-93.2] 84.1% [84.1-84.1]

router: 18 of 60 queries classified as identifier (keyword 12, mixed 5, paraphrase 1)

routed - fixed, paired per build (points of precision):
all +2.8 [+2.3 to +3.2] noise 0.8 → ABOVE the noise
keyword +5.7 [+4.2 to +6.7] noise 2.5 → ABOVE the noise
mixed -3.2 [-3.2 to -3.2] noise 0.0 → ABOVE the noise
paraphrase +5.5 [+4.7 to +5.9] noise 1.2 → ABOVE the noise
(one query changing one of its 10 results moves a group of n queries by 10/n points)

routing made precision WORSE on 5 queries (better on 10, same on 45):
50.0% → 0.0% (worse on 3/3 builds) [mixed, natural] redis is down
50.0% → 0.0% (worse on 3/3 builds) [keyword, natural] kafka consumer lag
70.0% → 40.0% (worse on 3/3 builds) [paraphrase, natural] emails are being sent hours late
80.0% → 66.7% (worse on 1/3 builds) [keyword, natural] temporary failure in name resolution
80.0% → 70.0% (worse on 3/3 builds) [mixed, identifier] HTTPS certificate is no longer valid

wrote evals/results/search-10k.json
recreating idx_logs_embedding_hnsw...

srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$ pnpm eval:rerank --stages=hybrid --doc=template

> sql-performance-lab@1.0.0 eval:rerank /home/srcareca/Documentos/node/sql-performance-lab
> ts-node --transpile-only src/scripts/rerank-eval.ts --stages=hybrid --doc=template

[dotenv@17.3.1] injecting env (5) from .env -- tip: 🛡️ auth for agents: https://vestauth.com
logs: 10.000 rows; reranker Xenova/ms-marco-MiniLM-L-6-v2 reading template; first stage like GET /search/logs (no INFO, ef_search 160, cw 2)

hybrid: precision@10 (queries with 0 relevant)
before top 20: after / ceiling top 50: after / ceiling  
text: all 96.5% (1) 97.0% (1) / 98.3% +2 -2 98.3% (1) / 98.3% +3 -0  
text: keyword 100.0% (0) 100.0% (0) / 100.0% +0 -0 100.0% (0) / 100.0% +0 -0  
text: mixed 98.9% (0) 98.4% (0) / 100.0% +0 -1 100.0% (0) / 100.0% +1 -0  
text: paraphrase 88.8% (1) 91.2% (1) / 94.1% +2 -1 94.1% (1) / 94.1% +2 -0  
codes: all 99.6% (0) 100.0% (0) / 100.0% +3 -0 100.0% (0) / 100.0% +3 -0  
rerank latency, all queries: top 20 p50 29 ms / p95 58 ms, top 50 p50 26 ms / p95 89 ms

typed queries whose precision changed (hybrid, top 20), top-3 root causes before -> after:
code crashed on a missing field 50.0% -> 100.0% [db_connection_timeout, null_reference, db_connection_timeout] -> [null_reference, null_reference, null_reference]
customers cannot pay, card processor is down 60.0% -> 100.0% [payment_gateway_5xx, payment_gateway_5xx, null_reference] -> [payment_gateway_5xx, payment_gateway_5xx, payment_gateway_5xx]
orders page takes forever to load from the d 100.0% -> 50.0% [slow_query, slow_query, slow_query] -> [slow_query, slow_query, slow_query]
HTTPS certificate is no longer valid 80.0% -> 70.0% [tls_cert_expired, tls_cert_expired, tls_cert_expired] -> [tls_cert_expired, tls_cert_expired, tls_cert_expired]

wrote evals/results/rerank-10k-template.json
srcareca@srcareca-System-Product-Name:~/Documentos/node/sql-performance-lab$
