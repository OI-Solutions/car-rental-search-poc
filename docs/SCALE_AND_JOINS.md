# Denormalized vs parent/child — a search-modeling audit at 2M rows

> Flat keeps each listing as **one finished document**, so a search reads it
> directly. Parent/child splits the car's details into a separate record and
> **rejoins them on every query**. This page walks three real searches, then customer
> pricing, to show what that split costs on reads — and the storage and write costs
> flat pays in return.

Two indexes hold the same 2,000,000 cars and return the **same results** (the
benchmark asserts equal hit counts). They differ only in storage. Local single-node
`bench_*` indexes, never touched by the app.

> **A note on the numbers.** Storage and result counts below are **exact and
> reproducible**. Latency is **directional only**: on a single-node laptop cluster,
> sub-100 ms timings are dominated by GC and cache noise — the same query's
> flat-vs-join ratio swung from ~2× to ~13× across runs — so we do **not** quote a
> precise multiple. What every run agreed on: parent/child was **slower** on any read
> that touches a car attribute, because it does strictly more work. The direction is
> guaranteed; the magnitude is environment-dependent.

---

## Part 1 — The data

**5k real car rentals from Kaggle
([Cornell](https://www.kaggle.com/datasets/kushleshkumar/cornell-car-rental-dataset))
were expanded to 2,000,000 listings** from a small set of reusable pieces:

- **547 car models** and **964 cities** — both real, reused across the set.
- each city holds several branch **locations** (~6,000 total).
- each **listing** = one model at one location, with its own price, year, and stock.

| | Cornell set | expansion |
| --- | --- | --- |
| car listings | 5,851 | **2,000,000** |
| car models | 547 | 547 |
| rental locations | individual owners | 5,996 |
| cities | 1,017 | 964 |

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

That split — car details off the listing — is why parent/child re-crosses a join on
every read below. Flat did that join **once, at write time**.

---

## Part 2 — The structure in action

### Search 1: all SUVs

Flat reads the type straight off each listing — one lookup. Parent/child has to
resolve the join to the 611,000 SUVs' car records. Same result, strictly more work.

```json
// FLAT
{ "query": { "term": { "vehicle_class": "suv" } } }
```
```json
// PARENT/CHILD
{ "query": { "has_parent": { "parent_type": "vehicle_model",
                             "query": { "term": { "vehicle_class": "suv" } } } } }
```

There is no way to filter listings by a car attribute without the `has_parent` join —
so parent/child is always doing extra work here, and was slower on every run.

### Search 2: narrow it down — available SUVs in Las Vegas under \$80

A real search adds filters. Each one shrinks the result set; the counts are identical
either way (this is the reproducible part):

| filter | results |
| --- | ---: |
| all inventory | 2,000,000 |
| SUVs | 611,042 |
| + Las Vegas | 19,599 |
| + under \$80 | 10,586 |

Filters prune ~99.5% of the space, so both layouts get fast once narrowed. But the
SUV filter is still a `has_parent` join for parent/child at every step — it is never
cheaper than flat, only less expensive in absolute terms as the set shrinks.

```json
// FLAT — every clause is a plain filter on the listing
{ "query": { "bool": { "filter": [
  { "term":  { "vehicle_class": "suv" } },
  { "term":  { "dealership_city": "Las Vegas" } },
  { "range": { "base_daily_rate": { "lte": 80 } } },
  { "range": { "quantity_available": { "gt": 0 } } } ] } } }
```
```json
// PARENT/CHILD — city/price/stock stay on the listing; the type filter becomes a join
{ "query": { "bool": { "filter": [
  { "term":  { "dealership_city": "Las Vegas" } },
  { "range": { "base_daily_rate": { "lte": 80 } } },
  { "range": { "quantity_available": { "gt": 0 } } },
  { "has_parent": { "parent_type": "vehicle_model",
                    "query": { "term": { "vehicle_class": "suv" } } } } ] } } }
```

### Search 3: cheapest rate for each type

Flat groups listings by their own type and takes the min — one plain aggregation. On
parent/child the type is on the car record, so the aggregation must cross the join. It
**can** be one query (the `children` aggregation), so "you need N queries" is *not*
the argument — but it still crosses the join, so it's still slower. The cost is the
join, not the query count.

```json
// FLAT — group listings by their own type
{ "size": 0, "aggs": { "by_type": {
    "terms": { "field": "vehicle_class" },
    "aggs": { "cheapest": { "min": { "field": "base_daily_rate" } } } } } }
```
```json
// PARENT/CHILD — one query, but it crosses the join: bucket car records by type, descend to listings
{ "size": 0, "aggs": { "by_type": {
    "terms": { "field": "vehicle_class" },
    "aggs": { "listings": { "children": { "type": "inventory" },
      "aggs": { "cheapest": { "min": { "field": "base_daily_rate" } } } } } } } }
```

Same answer either way (cheapest car \$15, SUV \$22, minivan \$24, truck \$25, van
\$25).

---

## Part 3 — Customer pricing lives outside the index

Pricing is per-customer and changes constantly — many-to-many (customer × dealership
× class), so it fits the inventory index neither denormalized (inventory × customers)
nor as parent/child (one parent, still re-crossed per read).

So it stays out of the index. Each search runs a **second, small query** against
`customer_agreements` for this customer's active discounts, and the app applies them
to the results it returns — effective price = base × (1 − discount), over the one page
on screen, not the corpus. Prices change without touching the inventory index.

---

## Subnotes — the reproducible numbers and the honest trade-offs

The two things that are **exact and reproducible**:

| | Flat | Parent/child | |
| --- | --- | --- | --- |
| storage on disk | ~510 MB | ~385 MB | **join −24%** |
| result counts (Search 2 ladder) | 2,000,000 → 10,586 | identical | exact both ways |

Where parent/child genuinely wins:
- **Storage / indexing** — child docs drop the repeated car fields, so the index is
  ~24% smaller and ingests a touch faster. Disk is the cheapest resource.
- **One narrow write case** — if a *shared car detail* changes (rename a model), it's
  one edit vs re-indexing that model's listings. But `make`/`class`/`seats` are
  reference data — they don't change.

Where flat wins (beyond read latency, which we don't quote precisely):
- **Everyday writes** — the updates that actually happen (a listing's price, stock,
  status) are a single-doc write in *both* models, since they live on the listing. No
  advantage to parent/child there.
- **Operability** — flat writes are plain `index` calls; parent/child needs `routing`
  on every write, a parent to exist first, a join field in the mapping, and routing
  preserved through reindex/backup. Flat is simpler to run.
- **Query shape** — plain `term`/`range`/`terms` vs `has_parent`/`children`/
  `inner_hits`.
- **Shard balance** — flat hashes evenly; parent/child routes children to their
  parent's shard, so shard sizes track model popularity (skew, hot-shard risk).
- **Heap** — the join field loads global ordinals into heap, growing with the
  catalog; flat has no such cost.

Parent/child's advantages are narrow but measurable: lower storage and cheaper updates to shared parent attributes. Flat's advantages are architectural and operational: simpler queries and writes, unconstrained shard distribution, no join-specific heap structures, and no routing dependency. For this workload, the frequently changing fields already belong to the listing itself, so parent/child's principal update advantage rarely applies.

## Reproduce

```bash
docker compose up -d && python scripts/wait_for_opensearch.py   # OS_HEAP=4g recommended
python scripts/bench_generate_ingest.py --target 2000000        # builds bench_flat + bench_join
python scripts/bench_run.py                                     # storage + result counts (the reliable numbers)
```

> For trustworthy *latency* figures you'd need a controlled, properly-sized cluster
> averaged over many runs — not a single-node laptop, where the measurement noise
> exceeds the flat-vs-join difference.
