# Scale & data modeling: why denormalized, not parent/child

> **TL;DR** — At millions of inventory rows, filters do the heavy lifting: each
> added constraint prunes the candidate space by orders of magnitude, so search
> stays fast. The open modeling question is *how the vehicle-model relationship is
> physically stored*. This POC **denormalizes** model fields onto every inventory
> document. The alternative — an OpenSearch **parent/child `join`** — keeps models
> as parent docs and joins at query time. This page measures the difference on the
> same ~2M-row corpus and the same queries. Denormalization wins the **read** path
> (the search); parent/child would only pay off for a **write** pattern this app
> doesn't have.

## The scenario

Centralized inventory search across many dealerships and millions of vehicles. A
user narrows with filters — vehicle class, city, price ceiling, seats — and expects
sub-100ms results. The data is seeded from the real [Cornell Car Rental
dataset](https://www.kaggle.com/datasets/kushleshkumar/cornell-car-rental-dataset)
(≈550 real make/model/type combinations, metros sampled by real listing density)
and expanded with deterministic variation to ~2,000,000 inventory rows.

This benchmark runs on a **local single-node OpenSearch cluster** (`docker compose
up`), not the tiny demo box — the fixture backend still serves the small live demo
with no cluster. It is a modeling-cost artifact, not a production load test.

## Two indexes, identical results, different physical model

Both indexes are built in one pass from the same generator and are **equivalent in
what they return** — the benchmark asserts identical hit counts at every stage. The
only difference is where the vehicle-model attributes live.

| | `bench_flat` (this POC) | `bench_join` (alternative) |
|---|---|---|
| Model fields (make, class, seats, fuel…) | copied onto **every** inventory doc | stored once on a **parent** `vehicle_model` doc |
| A query filtering on model fields | plain `term`/`range` on one flat doc | `has_parent` join against the parent |
| Doc relationship | none — self-contained | `join` field, child routed to parent's shard |
| Cost paid at… | **write / storage** (fan-out, fatter docs) | **read / memory** (join + global ordinals) |

The query ladder adds one filter per rung, so the candidate set narrows sharply.
`class=suv` and `seats>=7` are **model** attributes (the parent in the join model);
`city` and `price` are **inventory** attributes (the child).

```
flat:  bool.filter[ term class=suv, term city, range price<=80, range seats>=7 ]
join:  bool.filter[ term city, range price<=80,
                    has_parent(vehicle_model, bool.filter[ term class=suv, range seats>=7 ]) ]
```

## Results

<!-- BENCH_RESULTS_START -->
**2,000,000 inventory rows** (`bench_flat`) vs **2,000,000 children + 547 parents**
(`bench_join`), 3 shards each, single local node, 50 iterations/stage, `size:20`,
request cache off. Server-side `took` (ms). Hit counts are asserted identical
between the two models at every stage.

| filter added | candidate rows | flat mean | flat p95 | join mean | join p95 | join ÷ flat |
|---|--:|--:|--:|--:|--:|--:|
| `match_all` (all inventory) | 2,000,000 | 0.8 | 1.0 | 1.0 | 1.0 | 1.2× |
| `+ class=suv` | 611,042 | **1.0** | 1.0 | **13.5** | 14.4 | **13.5×** |
| `+ city` | 19,599 | 2.0 | 3.9 | 2.4 | 3.0 | 1.2× |
| `+ price ≤ 80` | 10,586 | 2.0 | 2.0 | 2.7 | 3.0 | 1.4× |
| `+ seats ≥ 7` | 10,586 | 1.9 | 2.0 | 3.0 | 3.0 | 1.6× |

**Storage & memory**

| | `bench_flat` | `bench_join` |
|---|--:|--:|
| Store size | **517 MB** | 391 MB |
| Docs | 2,000,000 | 2,000,547 |
| Fielddata heap (global ordinals) after join queries | — | ~0 MB @ 547 parents |

Headlines:

- **Filters prune ~99.5% of the space** — 2,000,000 → 10,586 rows in four
  constraints. This is why search over millions stays fast on either model.
- **The join tax spikes on a broad model-attribute filter.** `class=suv` alone
  matches 611k rows; the parent/child model must resolve parent→child across all of
  them → **13.5× slower** (13.5 ms vs 1.0 ms). The flat index answers it as one
  `term` filter. Once a selective *child* filter (city) is applied first, the join
  set shrinks and the gap collapses to ~1.2–1.6× — but the join is never cheaper.
- **Denormalization's bill is storage: +32%** (517 vs 391 MB) from copying model
  fields onto every row. Global-ordinals heap for the join is ~0 here because
  parent cardinality is low (547 models); it grows with parent count, so a
  high-cardinality parent would raise the join's memory cost too.

> `seats ≥ 7` doesn't narrow further because every SUV in the synthetic specs seats
> 7 — it's kept to exercise a *second* parent-attribute filter in the join path.
<!-- BENCH_RESULTS_END -->

## Reading the result honestly

- **Filters are the story.** Each constraint cuts the candidate space by orders of
  magnitude. Post-filter, both models touch a small set — which is exactly why a
  well-filtered search over millions of rows is cheap.
- **Parent/child is a read tax.** The join resolves the parent match per query,
  holds **global ordinals** for the join field in heap (rebuilt on refresh, growing
  with parent cardinality), and forces every child onto its parent's shard —
  capping horizontal scaling and risking hot shards.
- **Denormalization's bill is real too, just elsewhere.** Model fields are copied
  onto every row (larger store), and changing a model attribute means re-indexing
  every affected inventory doc (write fan-out). This app's model attributes are
  effectively static and reads dominate, so that bill is cheap to pay — which is
  precisely why denormalization is the right call *here*, and would not be for a
  write-heavy, high-parent-cardinality relationship.

## Reproduce

```bash
docker compose up -d && python scripts/wait_for_opensearch.py
python scripts/bench_generate_ingest.py --target 2000000   # builds bench_flat + bench_join
python scripts/bench_run.py --iterations 30                 # prints table, writes bench_results.json
```

Both indexes are isolated (`bench_*`) and never touched by the app or its tests.
