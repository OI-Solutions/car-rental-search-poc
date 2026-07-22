# Parent/child vs denormalized — a cost audit at 2M rows

> **Premise:** for a read-heavy, centralized search over millions of rows, an
> OpenSearch **parent/child `join`** is more expensive than **denormalization** on
> every dimension that matters. This page proves it dimension by dimension — each
> with a measured stat, an example document, and an example query — on the same
> ~2M-row corpus. It also states honestly the two places parent/child is *cheaper*
> (disk and one-time writes) and why they don't rescue this workload.

## The setup

Two indexes built in one pass from the same generator, **identical in results**
(the benchmark asserts equal hit counts at every stage), differing only in how the
vehicle-model relationship is physically stored. Dealership fields are denormalized
on both, so the *only* variable is the model relationship.

- `bench_flat` — every inventory doc carries a full copy of its vehicle-model fields.
- `bench_join` — vehicle models are **parent** docs; inventory are **child** docs
  joined by the `rel` field and routed to the parent's shard.

Seeded from the real [Cornell dataset](https://www.kaggle.com/datasets/kushleshkumar/cornell-car-rental-dataset)
(547 real models, metros by real density), expanded to ~2,000,000 rows. Runs on a
**local single-node cluster** (`docker compose up`), not the fixture. The app and
its tests never touch `bench_*`.

## The data: from 5,851 real cars to 2,000,000

We started with a real dataset from Kaggle — **5,851 actual car rentals** (the
[Cornell set](https://www.kaggle.com/datasets/kushleshkumar/cornell-car-rental-dataset)).
Each one is a car offered for rent: its make, model, type, daily price, and city.

That's too few to feel like searching through millions, so we made more from it: we
kept the same **547 real car models**, spread them across **~6,000 rental locations**
in **~960 cities**, and built **2,000,000 listings** — each a real car at a location,
with its price, year, and stock count varied a little so they're not all the same.

| | we started with | we ended up with |
| --- | --- | --- |
| car listings | 5,851 | **2,000,000** |
| car models | 547 | 547 |
| rental locations | individual owners | 5,996 |
| cities | 1,017 | 964 |
| daily price | \$20–\$1,500 | \$15–\$1,539 (avg \$116) |

Rebuild it any time with `scripts/bench_generate_ingest.py --target 2000000`.

## The two ways to store it

Both indexes hold the same 2,000,000 cars and give the same answers. Only the
storage differs:

| | Flat | Parent/child |
| --- | --- | --- |
| documents stored | 2,000,000 | 2,000,547 |
| car details (make, model, type, seats) | on every listing | in one separate record |
| listing details (city, price, stock) | on the listing | on the listing |
| to filter by car type | read the listing | join to the car record |
| size on disk | 517 MB | 391 MB |

The same car, stored both ways —

**Flat** — one document holds the whole listing:

```json
{
  "inventory_id": "INV-00652412", "dealership_city": "Las Vegas", "dealership_state": "NV",
  "make": "Volkswagen", "model": "Passat", "vehicle_class": "car", "seats": 5,
  "fuel_type": "gasoline", "transmission": "automatic",
  "year": 2009, "quantity_available": 2, "base_daily_rate": 50, "status": "limited"
}
```

**Parent/child** — the car's details sit in a separate record; the listing points to it:

```json
// parent doc  (_id = routing = vehicle_model_id)
{ "vehicle_model_id": "VM-VOLKSWAGEN-PASSAT-CAR", "make": "Volkswagen", "model": "Passat",
  "vehicle_class": "car", "seats": 5, "fuel_type": "gasoline", "rel": "vehicle_model" }
```
```json
// child doc  (routed to its parent's shard)
{ "inventory_id": "INV-00652412", "dealership_city": "Las Vegas", "dealership_state": "NV",
  "year": 2009, "quantity_available": 2, "base_daily_rate": 50, "status": "limited",
  "rel": { "name": "inventory", "parent": "VM-VOLKSWAGEN-PASSAT-CAR" } }
```

That single split — model attributes off the searchable doc — is the root cause of
every cost below: any query touching a model attribute now needs a **join**.

## The cost matrix

| Dimension | Flat (denormalized) | Parent/child (join) | Winner | Magnitude |
|---|---|---|---|---|
| **Read — broad filter** (`class=suv`, 611k hits) | 1.0 ms | 13.5 ms | flat | **13.5× slower** |
| **Read — fully filtered** (class+city+price+seats) | 1.9 ms | 3.0 ms | flat | 1.6× slower |
| **Aggregation / faceting** (available units per class) | 9 ms · **1 query** | 60 ms · **5 queries** | flat | **6.7× + 5× the queries** |
| **Query shape** (filter on a model attribute) | one `term` | `has_parent` subquery | flat | needs a join clause |
| **Shard balance** (2M rows, 3 shards) | 1.00 skew | 1.11 skew | flat | children pinned to parent shard |
| **Heap** (global ordinals for the join field) | none | O(parent cardinality) | flat | ~0 MB @ 547 parents, unbounded |
| **Write ergonomics** | plain `index` | `routing` required, parent must exist | flat | every write |
| — | | | | |
| **Storage** | 517 MB | 391 MB | *join* | join 24% smaller |
| **Indexing throughput** | 43.7k/s | 45.8k/s | *join* | join ~5% faster |
| **Single model-attribute update** | re-index every matching row | one parent doc | *join* | fan-out |

Everything above the divider is a read-path or operability cost — the things a
search service is judged on. Everything below is where parent/child wins: disk and
one-time writes.

---

## Level-by-level

### 1. Read latency — the flagship cost (13.5×)

A broad filter on a model attribute makes the join resolve parent→child across
every match. `class=suv` matches 611k rows: flat answers with a single `term`;
parent/child pays 13.5×.

```json
// flat — inventory/_search
{ "query": { "bool": { "filter": [ { "term": { "vehicle_class": "suv" } } ] } } }
```
```json
// join — bench_join/_search  (same result, 13.5× the time)
{ "query": { "bool": { "filter": [
  { "has_parent": { "parent_type": "vehicle_model",
                    "query": { "term": { "vehicle_class": "suv" } } } } ] } } }
```

Narrowing helps both (a selective *child* filter shrinks the join set), but the
join is never cheaper — 1.6× even fully filtered.

### 2. Aggregation / faceting (6.7×, and it takes 5 queries)

**Walk it through.** Picture the sidebar count a user expects: *how many available
vehicles of each type — car, SUV, minivan, truck, van?*

- **Flat — you ask once.** Every listing already carries its own `vehicle_class`, so
  OpenSearch groups all 2,000,000 rows by class and sums the available quantity in a
  single pass. **≈ 9 ms, 1 query.**
- **Parent/child — you ask five times.** The class lives on the *parent* record, so
  the listings can't be grouped by it in one go. You ask class by class — "how many
  available cars?", then SUVs, minivans, trucks, vans — each a `has_parent` join —
  then add the five answers together yourself. **≈ 60 ms, 5 queries.**

```json
// flat — one query, one pass
{ "size": 0,
  "query": { "bool": { "filter": [ { "term": { "status": "available" } } ] } },
  "aggs": { "by_class": { "terms": { "field": "vehicle_class" },
            "aggs": { "units": { "sum": { "field": "quantity_available" } } } } } }
```
```json
// join — repeat once per class, then sum client-side
{ "size": 0,
  "query": { "bool": { "filter": [
    { "term": { "status": "available" } },
    { "has_parent": { "parent_type": "vehicle_model",
                      "query": { "term": { "vehicle_class": "suv" } } } } ] } },
  "aggs": { "units": { "sum": { "field": "quantity_available" } } } }
```

```json
// flat — one query, one pass
{ "size": 0,
  "query": { "bool": { "filter": [ { "term": { "status": "available" } } ] } },
  "aggs": { "by_class": { "terms": { "field": "vehicle_class" },
            "aggs": { "units": { "sum": { "field": "quantity_available" } } } } } }
```
```json
// join — repeat once per class, then sum client-side
{ "size": 0,
  "query": { "bool": { "filter": [
    { "term": { "status": "available" } },
    { "has_parent": { "parent_type": "vehicle_model",
                      "query": { "term": { "vehicle_class": "suv" } } } } ] } },
  "aggs": { "units": { "sum": { "field": "quantity_available" } } } }
```

### 3. Query shape & expressiveness

Every model-attribute filter, sort, or aggregation on parent/child needs a
`has_parent`/`has_child` wrapper; returning parent fields with children needs
`inner_hits` (extra fetch); you cannot sort children by a parent field or facet
across the boundary in one pass. On the flat doc these are ordinary `term`,
`range`, `sort`, and `terms` clauses. (Compare the pairs in §1–2.)

### 4. Shard balance & horizontal scaling

Children are **routed to their parent's shard**, so shard sizes track parent
popularity, not an even hash. Measured over 2M rows on 3 shards: flat is balanced
(**1.00**, 666k–667k docs/shard); join is skewed (**1.11**, 640k–709k). Skew grows
with popularity concentration, producing hot shards and capping how evenly the
index scales out.

### 5. Heap — a latent, unbounded cost

The join field loads **global ordinals** into heap, rebuilt on refresh and growing
with parent cardinality. At 547 parents it's negligible (~0 MB measured) — but it's
a heap liability the flat index simply never has, and it scales with your catalog,
not your control.

### 6. Write ergonomics

Every child write must set `routing` to its parent and the parent must already
exist; reindex and update-by-query must preserve routing. Flat writes are plain
`index` calls with a natural `_id`. (See the two example documents above — the
child's `rel.parent` + routing is mandatory operational surface.)

---

## Where parent/child is *cheaper* — and why it doesn't save this workload

Being honest about the trade makes the conclusion stronger, not weaker:

- **Storage: join is 24% smaller** (391 vs 517 MB) — child docs drop the repeated
  model fields. But disk is the cheapest resource in the system; you'd trade it to
  lose **13.5× on the hot query** and **6.7× on facets**.
- **Indexing: join is ~5% faster** (45.8k vs 43.7k docs/s) — smaller child docs.
  A one-time, marginal win against a per-query, permanent loss.
- **Single model-attribute update**: change a model once (one parent) vs re-index
  every matching inventory row. This is the *only* dimension that could matter —
  and only if model attributes churn. Here `make`/`class`/`seats` are effectively
  static, so the fan-out that denormalization pays is rare and cheap.

**Net:** parent/child trades away the two cheapest, least-frequent costs (disk,
one-time writes) to make the two most frequent, most latency-sensitive operations
(filtered search, faceting) 6–14× more expensive — plus shard skew, heap, and write
complexity. For centralized search over millions of read-mostly rows,
denormalization wins.

## Reproduce

```bash
docker compose up -d && python scripts/wait_for_opensearch.py
python scripts/bench_generate_ingest.py --target 2000000   # builds bench_flat + bench_join (~80s)
python scripts/bench_run.py --iterations 30                 # read-latency ladder  -> scripts/bench_results.json
python scripts/bench_dimensions.py --index-sample 500000    # agg/memory/skew/indexing -> scripts/bench_dimensions.json
```
