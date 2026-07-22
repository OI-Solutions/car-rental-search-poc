# Parent/child vs denormalized — a cost audit at 2M rows

> **The verdict:** the one-document (flat) layout wins on what matters most for a
> search index — **read and query speed** — and pays for it in **storage and slower
> updates**. The principle it points to: **shape each index around the retrieval
> unit** — the thing a search returns (a ready-to-rank listing) — not around a tidy,
> normalized entity model. That's why this POC runs several purpose-built indexes
> instead of one.

Two indexes hold the same 2,000,000 cars and return the **same results** (the
benchmark asserts equal hit counts). They differ only in storage. Numbers are
server-side `took` on a local single-node cluster; the app and its tests never touch
these `bench_*` indexes. Reproduce with the commands at the end.

---

## Part 1 — The data

### From 5,851 real cars to 2,000,000

**What we started with:** 5,851 real car rentals from Kaggle (the
[Cornell set](https://www.kaggle.com/datasets/kushleshkumar/cornell-car-rental-dataset)).
Each row is one car — its make, model and type, daily price, and city. One row looks
like: *Tesla Model X · SUV · 2019 · \$135/day · Seattle, WA*.

**How `bench_generate_ingest.py` turns that into 2,000,000:**

1. Pull out the **547 distinct car models**, and note each model's average real price.
2. List the **1,017 cities**, and how busy each one was.
3. Make **2,000,000 listings**. Each one = a random car model, dropped in a city
   (busier cities more often) at one of 6 branch locations, priced at that model's
   average ±30%, with a random year (2006–2020) and stock count (0–5).

It's 2,000,000 random mixes of a real car, a
real city, and a realistic price, spreading the 547 models across **~6,000 locations
in 964 cities**.

| | Cornell set | expansion |
| --- | --- | --- |
| car listings | 5,851 | **2,000,000** |
| car models | 547 | 547 |
| rental locations | individual owners | 5,996 |
| cities | 1,017 | 964 |
| daily price | \$20–\$1,500 | \$15–\$1,539 (avg \$116) |

### The two indexes we search

Both hold the same 2,000,000 cars and give the same answers. Only the storage differs:

| | Flat (one document) | Parent/child (split) |
| --- | --- | --- |
| documents stored | 2,000,000 | 2,000,547 |
| car details (make, model, type, seats) | on every listing | in one separate record |
| listing details (city, price, stock) | on the listing | on the listing |
| to filter by car type | read the listing | join to the car record |

The same car, stored both ways:

```json
// FLAT — one document holds the whole listing
{ "inventory_id": "INV-00652412", "dealership_city": "Las Vegas",
  "make": "Volkswagen", "model": "Passat", "vehicle_class": "car", "seats": 5,
  "base_daily_rate": 50, "status": "limited" }
```
```json
// PARENT/CHILD — the car record (shared by all its listings) + the listing pointing at it
{ "vehicle_model_id": "VM-VW-PASSAT", "make": "Volkswagen", "model": "Passat",
  "vehicle_class": "car", "seats": 5 }
{ "inventory_id": "INV-00652412", "dealership_city": "Las Vegas",
  "base_daily_rate": 50, "status": "limited", "rel": { "parent": "VM-VW-PASSAT" } }
```

That split — car details off the listing — is the root cause of every read cost
below: any query touching a car attribute now needs a **join**.

---

## Part 2 — The structure in action

### Search 1: all SUVs

The simplest search on a car attribute. Flat reads the type off each listing;
parent/child joins out to the car records — and there are 611,000 SUVs to join.

```json
// FLAT
{ "query": { "term": { "vehicle_class": "suv" } } }
```
```json
// PARENT/CHILD
{ "query": { "has_parent": { "parent_type": "vehicle_model",
                             "query": { "term": { "vehicle_class": "suv" } } } } }
```

**1.0 ms flat vs 13.5 ms parent/child — 13.5× slower.**

### Search 2: narrow it down — available SUVs in Las Vegas under \$80

A real search adds filters. Each one shrinks the results, so both layouts get fast —
but parent/child stays behind at every step, because the SUV filter is still a join.

```json
// FLAT
{ "query": { "bool": { "filter": [
  { "term":  { "vehicle_class": "suv" } },
  { "term":  { "dealership_city": "Las Vegas" } },
  { "range": { "base_daily_rate": { "lte": 80 } } },
  { "range": { "quantity_available": { "gt": 0 } } } ] } } }
```
```json
// PARENT/CHILD — the city/price/stock filters stay on the listing; the type filter becomes a join
{ "query": { "bool": { "filter": [
  { "term":  { "dealership_city": "Las Vegas" } },
  { "range": { "base_daily_rate": { "lte": 80 } } },
  { "range": { "quantity_available": { "gt": 0 } } },
  { "has_parent": { "parent_type": "vehicle_model",
                    "query": { "term": { "vehicle_class": "suv" } } } } ] } } }
```

| filter | results | flat | parent/child |
| --- | ---: | ---: | ---: |
| all inventory | 2,000,000 | 0.8 ms | 1.0 ms |
| SUVs | 611,042 | 1.0 ms | **13.5 ms** |
| + Las Vegas | 19,599 | 2.0 ms | 2.4 ms |
| + under \$80 | 10,586 | 2.0 ms | 2.7 ms |

Filters prune the space by ~99.5%, so once narrowed both are fast — but the join is
never cheaper.

### Search 3: cheapest rate for each type

A filter panel wants the lowest price per type. Flat groups every listing by type and
takes the minimum in one query. Parent/child can't group by type (it's on the car
record), so you ask once per type and combine.

```json
// FLAT — one query
{ "size": 0, "aggs": { "by_type": {
    "terms": { "field": "vehicle_class" },
    "aggs": { "cheapest": { "min": { "field": "base_daily_rate" } } } } } }
```
```json
// PARENT/CHILD — repeat once per type (car, suv, minivan, truck, van), then keep the lowest per type
{ "size": 0,
  "query": { "has_parent": { "parent_type": "vehicle_model",
                             "query": { "term": { "vehicle_class": "suv" } } } },
  "aggs": { "cheapest": { "min": { "field": "base_daily_rate" } } } }
```

**120 ms (1 query) vs 784 ms (5 queries) — ~6.5× slower, and five round trips instead
of one.** (Answer either way: cheapest car \$15, SUV \$22, minivan \$24, truck \$25,
van \$25.)

---

## Subnotes — the other costs

Being honest about the trade: parent/child wins on storage and one-time writes (the
cheapest, least-frequent costs), and loses on a couple more operational dimensions.

| and also… | Flat | Parent/child | |
| --- | --- | --- | --- |
| size on disk | 517 MB | 391 MB | **join −24%** |
| indexing speed | 43.7k/s | 45.8k/s | **join ~5% faster** |
| change one car model | re-index all its listings | edit one record | **join simpler** |
| shard balance | even (1.00) | skewed (1.11) | flat |
| memory (global ordinals) | none | grows with the catalog | flat |

- **Storage / indexing** favor parent/child because child docs drop the repeated car
  fields — but disk is the cheapest resource, traded here to lose 13.5× on the hot
  query and ~6.5× on facets.
- **Updates**: changing a car attribute is one edit on parent/child vs a re-index of
  every matching listing on flat. Only matters if car attributes churn — here
  `make`/`class`/`seats` are effectively static.
- **Shard balance**: children are routed to their parent's shard, so shard sizes
  track model popularity (1.11 skew) rather than an even hash (1.00). Hot-shard risk,
  weaker scale-out.
- **Memory**: the join field loads global ordinals into heap, growing with catalog
  size — a liability flat never has.
- **Query shape**: every car-attribute filter, sort, or facet on parent/child needs a
  `has_parent`/`has_child` wrapper (and `inner_hits` to return car fields with a
  listing); on flat these are ordinary `term`/`range`/`terms` clauses.

## Reproduce

```bash
docker compose up -d && python scripts/wait_for_opensearch.py
python scripts/bench_generate_ingest.py --target 2000000   # builds bench_flat + bench_join (~80s)
python scripts/bench_run.py --iterations 30                 # read-latency ladder  -> scripts/bench_results.json
python scripts/bench_dimensions.py --index-sample 500000    # agg/memory/skew/indexing -> scripts/bench_dimensions.json
```
