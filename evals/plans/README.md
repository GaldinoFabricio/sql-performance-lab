# Planos de execução (Fase 5)

Cada arquivo `NN-*.txt` desta pasta é a saída de `EXPLAIN (ANALYZE, BUFFERS)` de um experimento. A tabela `logs` tinha 1.000.000 linhas. Tudo é gerado por `pnpm eval:plans` (`src/scripts/plan-experiments.ts`), e os números também ficam em `evals/results/plans-1m.json`.

Os estados "antes" (sem um índice, ou com um índice a mais) são criados **dentro de uma transação que sempre termina em `ROLLBACK`**. No PostgreSQL até `DROP INDEX` e `CREATE INDEX` são transacionais. Então dá para apagar um índice, rodar o `EXPLAIN` e desfazer tudo, sem reconstruir nada. Em produção não faça isso: o `DROP INDEX` trava a tabela inteira até o fim da transação.

## Como ler um plano

```
Limit  (cost=0.42..172.22 rows=50 width=93) (actual time=0.020..0.058 rows=50 loops=1)
  Buffers: shared hit=48
  ->  Index Scan using idx_logs_service_created_at on logs  (...)
        Index Cond: (service = 'payments'::text)
```

- **O plano é uma árvore.** Cada `->` é um nó filho que entrega linhas para o nó de cima. Leia de dentro para fora: o nó mais indentado é o primeiro a trabalhar.
- **`cost=início..total`** é a *estimativa* do planner, numa unidade própria (não são milissegundos). É por ela que o PostgreSQL escolhe o plano.
- **`rows=`** dentro de `cost` é quantas linhas o planner *acha* que vêm. Em `actual` é quantas vieram de fato. Quando as duas ficam muito longe, o planner decidiu com informação errada (normalmente estatísticas velhas: rode `ANALYZE`).
- **`actual time=início..fim`** é o tempo real, em ms. `loops=3` quer dizer que o nó rodou 3 vezes (por exemplo, uma por worker paralelo), e o tempo mostrado é a média por execução.
- **`Buffers: shared hit=48`** são as páginas de 8 KB que o nó leu.
  - `hit` veio da memória do PostgreSQL (shared buffers).
  - `read` veio de fora dela: do cache de arquivos do sistema operacional, ou do disco. Não dá para saber qual dos dois só pelo plano.
  - Um detalhe que aparece aqui: um Seq Scan numa tabela grande usa um "anel" pequeno de memória (256 KB) para não expulsar todo o resto do cache. Por isso ele quase sempre aparece como `read`, mesmo com a máquina cheia de memória.
  - A soma `hit + read` é a melhor medida de "quanto trabalho" uma consulta faz, porque não depende de a máquina estar ocupada ou não.
- **`Execution Time`** é o tempo de uma única execução, só dentro do servidor, e com o custo extra de cronometrar cada nó.
- **A coluna `p50`** das tabelas abaixo é o tempo medido pelo cliente (mediana de 5 execuções, depois de uma de aquecimento) e inclui mandar as linhas pela rede. Numa consulta que devolve 740 mil linhas, o `p50` é bem maior que o `Execution Time`.
- Para comparar planos, olhe primeiro as **páginas**, depois o `p50`.

## Os nós que aparecem aqui

| nó | o que faz |
|---|---|
| **Seq Scan** | Lê a tabela inteira, página por página, e testa o `Filter` em cada linha. `Rows Removed by Filter` mostra quantas linhas foram lidas à toa. |
| **Parallel Seq Scan** + **Gather** / **Gather Merge** | A mesma leitura completa, dividida entre vários processos (workers). O `Gather` junta os resultados; o `Gather Merge` junta mantendo a ordem. |
| **Sort** | Ordena. `top-N heapsort` é o caso esperto do `ORDER BY ... LIMIT N`: guarda só as N melhores linhas em vez de ordenar tudo. Mesmo assim, precisa *ver* todas as linhas antes de responder. |
| **Limit** | Para depois de N linhas. Só economiza trabalho se o nó de baixo já entrega as linhas na ordem certa. |
| **Index Scan** | Desce na árvore do B-tree até o primeiro valor que serve (`Index Cond`) e vai seguindo em ordem. Para cada entrada, busca a linha na tabela (o heap). |
| **Index Only Scan** | Igual, mas a resposta inteira está no índice, então não precisa ir à tabela. `Heap Fetches` conta as vezes em que precisou ir mesmo assim, para checar se a linha é visível (páginas que o `VACUUM` ainda não marcou como limpas). |
| **Bitmap Index Scan** + **Bitmap Heap Scan** | Em duas etapas. Primeiro o índice monta um mapa de *quais páginas* têm linhas que servem. Depois a tabela é lida nessas páginas, em ordem física. É o meio-termo entre o Index Scan (bom para poucas linhas) e o Seq Scan (bom para muitas). `Recheck Cond` é o filtro aplicado de novo na página. `Heap Blocks` é quantas páginas foram lidas. |
| **Aggregate** | Calcula `count(*)`, `sum`... sobre as linhas que recebe. |

## 1. Índice composto `(service, created_at DESC)`

A consulta "últimos 50 logs de um serviço":

```sql
SELECT id, created_at, level, message FROM logs WHERE service = 'payments' ORDER BY created_at DESC LIMIT 50;
```

| plano | nós | Execution Time | p50 | páginas lidas |
|---|---|---:|---:|---:|
| `01` sem índice | Limit → Gather Merge → Sort (top-N) → Parallel Seq Scan | 178 ms | 210 ms | 251.514 |
| `02` com o índice | Limit → Index Scan | 0,07 ms | 1,1 ms | 48 |

**Sem índice:** 3 processos leem a tabela inteira (1 milhão de linhas, 1,9 GB) e descartam 917 mil que não são de `payments`. Cada um guarda os 50 mais recentes que viu, e o `Gather Merge` junta os três.

**Com o índice:** as entradas de `payments` estão juntas no índice, *já ordenadas* por `created_at DESC`. O `Index Scan` vai direto para o começo delas, lê 50, e o `Limit` para. Sem `Sort`, e 48 páginas em vez de 251 mil. O `DESC` no índice nem é obrigatório (um B-tree pode ser lido de trás para frente), mas deixa a intenção clara.

A migration `20261116120000_add_logs_service_created_at_index.ts` cria esse índice com `CREATE INDEX CONCURRENTLY`:
- **Por que `CONCURRENTLY`:** um `CREATE INDEX` comum trava a tabela para escrita até terminar. Numa tabela de logs, isso significa parar a aplicação. O `CONCURRENTLY` deixa os INSERTs continuarem.
- **O preço:**
  - não pode rodar dentro de transação, então a migration desliga a transação do knex (`export const config = { transaction: false }`);
  - lê a tabela duas vezes e é mais lento;
  - se falhar no meio, deixa um índice **INVALID**. O planner não o usa, mas todo INSERT continua mantendo. E `CREATE INDEX ... IF NOT EXISTS` acha que ele existe e não faz nada. Por isso a migration primeiro verifica `pg_index.indisvalid` e apaga o resto inválido.

## 2. Prefixo à esquerda (*leftmost prefix*)

Um B-tree de `(service, created_at)` é ordenado como uma lista telefônica: primeiro por `service`, e dentro de cada serviço por `created_at`.

| plano | filtro | nós | Execution Time | páginas |
|---|---|---|---:|---:|
| `03` | `service =` **e** `created_at >=` | Index Scan, as duas colunas no `Index Cond` | 0,1 ms | 103 |
| `05` | só `service =` | Index Only Scan | 8 ms | 971 |
| `04` | só `created_at >=` | Sort → Index Scan (o índice **inteiro**) | 35 ms | 7.087 |

- **`03`:** usa as duas colunas para *posicionar* a busca: vai até `payments`, depois até a última hora, e lê só as 113 linhas certas.
- **`05`:** a primeira coluna sozinha também serve: é um prefixo do índice. Como o `count(*)` não precisa de nenhuma outra coluna, o PostgreSQL nem vai à tabela.
- **`04`:** o caso que não funciona do jeito que parece. A condição em `created_at` aparece como `Index Cond`, mas o PostgreSQL 17 não consegue *pular* direto para ela: precisa percorrer o índice inteiro (7.087 páginas, todos os serviços) e testar cada entrada. Depois ainda tem que ordenar, porque a ordem do índice é por serviço. Ainda é melhor que ler a tabela (o índice é bem menor), mas é mais de 300 vezes mais caro que o `03`.
  - O PostgreSQL 18 trouxe o *skip scan*, que pula de serviço em serviço e melhora esse caso. Mesmo assim, a regra continua: **ponha primeiro a coluna que sempre aparece com `=`**.
  - Se "erros da última hora" fosse uma consulta frequente, ela pediria um índice próprio começando por `created_at`. A seção 6 mostra exatamente isso.

## 3. Índice redundante e velocidade de INSERT

A pergunta: vale ter um índice só em `(service)` quando já existe `(service, created_at DESC)`? Todo filtro por `service` que ele atende, o composto também atende, pelo prefixo (seção 2). Na teoria é redundante, e todo índice custa a cada INSERT.

Para medir, copiei linhas da própria tabela (`INSERT ... SELECT`, com o embedding) dentro de uma transação desfeita no fim, somando um índice de cada vez:

| índices na tabela | linhas/s (mediana) | variação entre rodadas | WAL por linha |
|---|---:|---:|---:|
| só a chave primária | 89.896 | 16.610–110.911 | 1.803 B |
| + `(service, created_at)` | 62.376 | 12.022–69.867 | 1.943 B |
| + `(service, created_at)` + `(service)` | 55.621 | 5.457–67.108 | 1.956 B |
| + GIN full-text | 8.956 | 5.405–19.436 | 3.271 B |
| + GIN + HNSW (todos os índices de produção) | **441** | 428–469 | **15.309 B** |

**WAL** (*write-ahead log*) é o diário em que o PostgreSQL escreve toda mudança antes de aplicá-la. Bytes de WAL por linha medem exatamente quanto cada índice faz a mais a cada INSERT. Diferente do tempo, esse número não oscila.

- **O tempo oscilou demais para comparar índices B-tree.** A mesma variante variou até 10 vezes entre rodadas (checkpoints, cache, a tabela crescendo com as linhas desfeitas). Mesmo intercalando as variantes, `+ (service)` chegou a sair mais rápido que sem ele, o que só pode ser ruído. Por isso o WAL é a medida que vale aqui.
- **O índice "redundante" quase não custa nada neste caso:** +13 bytes de WAL por linha, contra +140 do composto. Ele tem só 7 MB, contra 49 MB do composto. O motivo é a **deduplicação** do B-tree (PostgreSQL 13+): `service` tem só 11 valores, e o índice guarda cada valor uma vez, com a lista de linhas.
- **O planner até prefere o índice redundante** para `count(*) WHERE service = 'shipping'` (plano `06`): lê 93 páginas, contra 971 pelo composto (plano `05`), porque o índice é menor.
- **Então a regra "índice redundante é desperdício" depende do caso.**
  - Para uma coluna com muitos valores diferentes (um `user_id`, um texto longo), o índice redundante custaria quase o mesmo que o composto.
  - Aqui ele custa pouco e acelera um `count` por serviço. Mesmo assim, é mais uma coisa para o `VACUUM` manter e para ocupar memória de cache. Eu o deixaria de fora até o `pg_stat_statements` mostrar que aquele `count` pesa.
- **Os índices caros de verdade são os outros dois:**
  - O GIN (full-text) aumenta o WAL por linha em ~70% e corta a velocidade de INSERT para cerca de um sexto.
  - O HNSW multiplica o WAL por 5 e derruba a velocidade para **441 linhas por segundo**, cerca de 200 vezes menos que sem ele. Cada linha nova entra no grafo procurando seus vizinhos, como uma busca.
  - Para uma tabela de logs, que recebe muitas escritas, esse é o custo que mais pesa na arquitetura. O modelo de embeddings, que gera ~325 linhas/s nesta máquina, já é o gargalo do mesmo tamanho. Por isso, em produção, embedding e indexação vetorial costumam ficar fora do caminho do INSERT: a linha entra sem vetor, e um processo à parte calcula o embedding depois. É o que o `pnpm embed:logs` já faz.

## 4. 500 linhas contra 1 milhão

A mesma consulta (`SELECT id, created_at, level FROM ... WHERE service = ?`), o mesmo índice, numa cópia com as primeiras 500 linhas (16 páginas) e na tabela inteira (251 mil páginas):

| tabela | filtro | plano escolhido | Execution Time | p50 | sem índice (forçado) |
|---|---|---|---:|---:|---:|
| 500 linhas | `api-gateway` (36%) | `07` Seq Scan | 0,3 ms | 4,3 ms | — |
| 500 linhas | `shipping` (4%) | `08` Bitmap Index + Heap Scan | 0,07 ms | 1,0 ms | `09` Seq Scan: 0,1 ms, p50 0,8 ms |
| 1M | `api-gateway` (36%) | `10` Seq Scan | 446 ms | 800 ms | — |
| 1M | `shipping` (4%) | `11` Bitmap Index + Heap Scan | 42 ms | 117 ms | `12` Seq Scan: 423 ms, p50 457 ms |

Eu esperava ver o famoso "em tabela pequena o PostgreSQL ignora o índice". **Com 500 linhas, não foi o que aconteceu:** para `shipping` ele usou o índice mesmo assim. O que decide não é o número de linhas, e sim:

1. **Que fração da tabela o filtro devolve (seletividade).** Para 36% das linhas (`api-gateway`), ele lê a tabela inteira nos dois tamanhos. Para 4% (`shipping`), usa o índice nos dois.
2. **Quantas páginas a tabela tem.** Testando à parte, uma tabela com 100 linhas (2 páginas) já recebe Seq Scan mesmo para `shipping`: ler 2 páginas sai mais barato que abrir o índice.

O que **muda de verdade** com o tamanho é se a escolha *importa*:
- **Com 500 linhas**, o melhor e o pior plano estão a menos de 0,1 ms um do outro (o tempo de rede pesa mais que o plano).
- **Com 1 milhão**, o índice tira 340 ms de cada consulta e lê 40 mil páginas em vez de 251 mil.

Por isso um teste com uma tabela pequena não diz nada sobre o plano em produção. É preciso olhar o `EXPLAIN` com o volume real (ou com estatísticas parecidas).

## 5. Filtro pouco seletivo: índice em `level`

`level` tem 4 valores, e um deles é quase tudo: INFO 74%, ERROR 13%, WARN 11%, FATAL 1,4%. Criei `idx_logs_level` (dentro da transação de teste) e comparei:

| plano | filtro | nós | páginas | Execution Time | p50 |
|---|---|---|---:|---:|---:|
| `13` | `level = 'INFO'` (74%) | Seq Scan (índice ignorado) | 251.440 | 480 ms | 646 ms |
| `14` | `level = 'FATAL'` (1,4%) | Index Scan | 13.800 | 9 ms | 14 ms |
| `15` | `level = 'INFO'`, índice forçado (`enable_seqscan = off`) | Bitmap Index + Heap Scan | 248.865 | 404 ms | 801 ms |

- **Para INFO o índice não serve para nada.** Forçado a usá-lo, o PostgreSQL monta um mapa com 740 mil entradas e depois lê 248 mil das 251 mil páginas da tabela: o mesmo trabalho do Seq Scan, mais o índice.
- **O tempo não decide sozinho, e esta é uma boa lição sobre medir.**
  - No `p50` (5 execuções, medido no cliente), o Seq Scan ganha: 646 contra 801 ms.
  - No `Execution Time` (uma execução), o índice forçado parece ganhar: 404 contra 480 ms. Só que as páginas dele vieram todas da memória do PostgreSQL (`hit`), enquanto o Seq Scan, por causa do "anel" de 256 KB, buscou 201 mil páginas fora dela (`read`).
  - Numa rodada anterior, com a tabela inteira na memória, o Seq Scan ganhou também no `Execution Time` (311 contra 428 ms).
  - A diferença de tempo depende de onde estão as páginas naquele momento. O número de páginas não muda.
- **Um índice só ajuda quando elimina a maior parte das páginas.**
- **Para valores raros (FATAL, ERROR) o índice vale.** Nesse caso um **índice parcial** é ainda melhor: `CREATE INDEX ... ON logs (created_at) WHERE level IN ('ERROR','FATAL')`. Ele guarda só as linhas raras: fica pequeno, é barato de manter e atende exatamente a consulta de alertas da seção 6.

## 6. Filtro + vetor (HNSW + WHERE)

A busca "logs parecidos com X, só do serviço `shipping`" (4,3% das linhas):

```sql
SELECT id FROM logs WHERE service = 'shipping' ORDER BY embedding <=> $1 LIMIT 10;
```

**O problema:**
- O índice HNSW não sabe nada de `service`. Ele devolve os `ef_search` vizinhos mais próximos (40 por padrão), e só **depois** o PostgreSQL aplica o `WHERE`.
- Se só 4% das linhas são de `shipping`, sobram em média 40 × 4% ≈ 2 linhas, e não as 10 pedidas.
- No plano `16` aparece `Rows Removed by Filter: 40` e **zero** linhas devolvidas.
- O planner não percebe isso: ele escolheu o HNSW mesmo existindo o índice por `service`.

Medido com as 60 buscas digitadas de `evals/text_queries.json`, filtradas por `shipping`. O recall é comparado com a resposta exata para o mesmo filtro.

| plano | estratégia | linhas devolvidas (média de 10) | buscas com menos de 10 | recall@10 | p50 | p95 |
|---|---|---:|---:|---:|---:|---:|
| `16` | HNSW, `ef_search = 40` | 2,9 | 51 de 60 | 13,7% | 3,3 ms | 6,7 ms |
| `17` | HNSW, `ef_search = 400` | 5,5 | 36 | 35,0% | 5,9 ms | 17,7 ms |
| `18` | HNSW + **iterative scan** (`relaxed_order`) | 9,3 | 6 | 48,5% | 5,9 ms | 82,9 ms |
| `19` | **índice HNSW parcial** `WHERE service = 'shipping'` | 10 | 0 | 48,2% | 1,5 ms | 4,2 ms |
| `20` | sem HNSW: B-tree acha o serviço, distância calculada para todos | 10 | 0 | **100%** | 55 ms | 57 ms |

O que cada solução faz:
- **`ef_search` maior (`17`):** pede mais candidatos ao grafo e sobra mais coisa depois do filtro. Ajuda, mas não resolve: com 400 candidatos, 4% ainda dão ~16 no melhor caso, e mais da metade das buscas continua incompleta.
- **Iterative scan (`18`, pgvector 0.8):** quando o filtro esvazia o resultado, o HNSW continua andando no grafo e buscando mais candidatos, até completar o `LIMIT` ou chegar no teto de `hnsw.max_scan_tuples` (20 mil). No plano: `Rows Removed by Filter: 543`, ou seja, ele examinou 553 linhas para achar 10.
  - Quase todas as buscas voltam completas.
  - O p95 sobe para 83 ms nas buscas em que o serviço quase não aparece perto do vetor.
  - `relaxed_order` aceita resultados um pouco fora de ordem, em troca de velocidade.
- **Índice parcial (`19`):** um grafo HNSW só com as linhas de `shipping` (43 mil). Criá-lo levou 2,8 s. Como o filtro já está no índice, nada é descartado depois (o plano nem tem `Filter`).
  - É o mais rápido: 237 páginas, 0,15 ms no servidor.
  - O preço: um índice por valor do filtro. Funciona para poucos valores fixos (um por cliente grande, por exemplo), não para 11 serviços e muito menos para filtros por data.
- **B-tree + distância exata (`20`):** sem HNSW, o planner usa o índice composto para achar as 43 mil linhas de `shipping` (Bitmap Index Scan), calcula a distância para cada uma e guarda as 10 menores (`Sort` top-N heapsort). **É a resposta exata**, em 55 ms.

Por que o recall fica em ~48% mesmo nas soluções que devolvem 10 linhas: são buscas digitadas, fora da distribuição dos logs. Esse é o mesmo problema do `SEMANTIC_SEARCH.md` (achado 3), e o HNSW parcial (m=16, ef_construction=64, `ef_search` 40) também sofre com ele.

**Conclusão:**
- **Para um filtro que deixa poucas linhas** (dezenas de milhares), a resposta exata pelo B-tree é rápida o bastante (55 ms) e não erra nada. Para uma ferramenta de busca em logs, é a escolha certa.
- **Para filtros que deixam muitas linhas**, o HNSW sem filtro já funciona, porque a maioria dos candidatos passa no `WHERE`.
- **No meio-termo**, o iterative scan é a opção mais simples, desde que o p95 mais alto seja aceitável.
- **O índice parcial** vale quando há poucos valores de filtro, fixos e muito consultados.

## 7. `pg_stat_statements`: total contra média

O `pg_stat_statements` soma o tempo de cada consulta *normalizada*: valores diferentes viram `$1`, `$2`, então mil execuções com IDs diferentes contam como uma consulta só. Rodei uma carga pequena, com o formato de uma carga real:

| consulta | chamadas | média | total | % do total |
|---|---:|---:|---:|---:|
| alerta: `count(*)` de ERROR/FATAL nos últimos 15 min | 300 | 34 ms | 10,06 s | **92,9%** |
| busca `ILIKE '%...%'` | 3 | **108 ms** | 0,32 s | 3,0% |
| relatório `GROUP BY service, level` por dias | 3 | 66 ms | 0,20 s | 1,8% |
| últimos erros de um serviço (usa o índice composto) | 1500 | 0,11 ms | 0,17 s | 1,6% |
| busca por `id` | 3000 | 0,03 ms | 0,09 s | 0,8% |

(`21-pg-stat-statements.txt` tem as duas listagens, ordenadas por `total_exec_time` e por `mean_exec_time`.)

- **Ordenado pela média:** o `ILIKE` aparece em primeiro. É a consulta mais lenta *por chamada*, mas roda 3 vezes e responde por 3% do tempo do banco.
- **Ordenado pelo total:** o alerta aparece em primeiro. Ninguém reclamaria de 33 ms, mas ele roda o tempo todo e ocupa **93% do tempo do banco**. É o caso da seção 2 (`created_at` sozinho percorre o índice inteiro).
- **As duas ordens respondem perguntas diferentes:**
  - pela **média**: "qual consulta deixa o usuário esperando?" (latência);
  - pelo **total**: "onde o banco gasta a CPU?" (capacidade, custo).
- Aqui, o índice parcial da seção 5 derrubaria quase todo o tempo do banco. Otimizar o `ILIKE` mudaria 3%.

Para usar: o PostgreSQL precisa carregar a extensão ao iniciar (`shared_preload_libraries = 'pg_stat_statements'`, já configurado no `docker-compose.yml`). Depois é só rodar `CREATE EXTENSION pg_stat_statements`.
