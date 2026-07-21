# Example documents & queries

A tour of what actually lives in the indexes and how the POC queries them. Every
document below is a **real record** pulled from a freshly ingested cluster; every
query has a matching runnable file in [`opensearch/queries/`](../opensearch/queries/).

- **Indexes** are created from explicit mappings in `opensearch/mappings/` and
  loaded by `scripts/ingest_data.py`. The source `data/*.json` files are
  **normalized**; ingestion **denormalizes** dealership + vehicle-model fields onto
  each inventory doc (and readable names onto each agreement) so search needs no
  joins. See [`ACCESS_CONTROL.md`](./ACCESS_CONTROL.md) for the request flow and
  [`SCALE_AND_JOINS.md`](./SCALE_AND_JOINS.md) for why denormalized beats
  parent/child at scale.
- **Run a query** in Dashboards → Dev Tools, or with curl (self-signed cert → `-k`):

  ```bash
  curl -sk -u "admin:$OPENSEARCH_PASSWORD" \
    "https://localhost:9201/inventory/_search" \
    -H 'Content-Type: application/json' \
    -d @opensearch/queries/11_protected_search_bool_filter.json
  ```

  (Local dev maps OpenSearch to host port **9201**; adjust to taste.)

---

## Example documents

### `inventory` — one denormalized, self-contained search doc

The foreign keys in `data/inventory.json` (`dealership_id`, `vehicle_model_id`) are
resolved at ingest, so every field a search filters or displays is present here:

```json
{
  "inventory_id": "INV-TX-SAN-ANTONIO-0068",
  "dealership_id": "DLR-TX-SAN-ANTONIO",
  "dealership_name": "San Antonio Fleet Center",
  "dealership_city": "San Antonio",
  "dealership_state": "TX",
  "dealership_location": { "lat": 29.5324, "lon": -98.5445 },
  "vehicle_model_id": "VM-JEEP-LIBERTY-SUV",
  "make": "Jeep",
  "model": "Liberty",
  "vehicle_class": "suv",
  "description": "Jeep Liberty. Three-row SUV for crews, mixed terrain, and passenger-plus-cargo flexibility.",
  "seats": 7,
  "fuel_type": "gasoline",
  "transmission": "automatic",
  "cargo_capacity": "80 cu ft",
  "quantity_available": 5,
  "base_daily_rate": 29.0,
  "status": "available",
  "last_updated": "2026-07-04T12:00:00Z"
}
```

> `base_daily_rate` is the **public** rate. A customer's *personalized* rate is
> computed in the app from their agreements — it is never stored on inventory.

### `vehicle_models` — the catalog (also the join parent in the benchmark)

```json
{
  "vehicle_model_id": "VM-ACURA-MDX-SUV",
  "make": "Acura", "model": "MDX", "vehicle_class": "suv",
  "seats": 7, "cargo_capacity": "80 cu ft",
  "transmission": "automatic", "fuel_type": "gasoline",
  "description": "Acura MDX. Three-row SUV for crews, mixed terrain, and passenger-plus-cargo flexibility."
}
```

### `dealerships` — fleet locations with a `geo_point`

```json
{
  "dealership_id": "DLR-AZ-PHOENIX",
  "name": "Phoenix Fleet Center",
  "city": "Phoenix", "state": "AZ",
  "location": { "lat": 33.4523, "lon": -111.9945 }
}
```

### `customers` — the tenant

```json
{
  "customer_id": "CUS-001",
  "company_name": "Prairie Electric Services",
  "industry": "electrical_contractor",
  "home_city": "Phoenix",
  "account_status": "active"
}
```

### `customer_agreements` — negotiated, tiered pricing

Two of CUS-001's active agreements. `vehicle_class: null` is a **dealership-wide**
discount; a non-null class is a **class-specific tier** that overrides the
dealership-wide rate for that class (see `backend/src/services/pricingService.ts`):

```json
{
  "agreement_id": "AGR-0001", "customer_id": "CUS-001",
  "customer_company_name": "Prairie Electric Services", "customer_home_city": "Phoenix",
  "dealership_id": "DLR-CA-SAN-DIEGO", "dealership_name": "San Diego Fleet Center", "dealership_city": "San Diego",
  "vehicle_class": null, "discount_percent": 31.0,
  "valid_from": "2026-01-01", "valid_to": "2026-12-31", "agreement_status": "active"
}
```
```json
{
  "agreement_id": "AGR-0003", "customer_id": "CUS-001",
  "dealership_id": "DLR-NV-LAS-VEGAS", "dealership_name": "Las Vegas Fleet Center", "dealership_city": "Las Vegas",
  "vehicle_class": "minivan", "discount_percent": 21.0,
  "valid_from": "2026-01-01", "valid_to": "2026-12-31", "agreement_status": "active"
}
```

### `bench_join` — the parent/child model (benchmark only)

Vehicle models become **parent** docs; inventory becomes **child** docs joined by
the `rel` field and routed to the parent's shard. Note the child carries **no**
model fields — that is exactly why filtering on `vehicle_class` needs a
`has_parent` join instead of a plain `term` (the read cost measured in
[`SCALE_AND_JOINS.md`](./SCALE_AND_JOINS.md)):

```json
// parent (_id and routing = vehicle_model_id)
{ "vehicle_model_id": "VM-ACURA-ILX-CAR", "make": "Acura", "model": "ILX",
  "vehicle_class": "car", "seats": 5, "fuel_type": "gasoline",
  "description": "Acura ILX. Efficient passenger car …", "rel": "vehicle_model" }
```
```json
// child (routed to its parent)
{ "inventory_id": "INV-00652412", "dealership_city": "Las Vegas", "dealership_state": "NV",
  "year": 2009, "quantity_available": 2, "base_daily_rate": 50, "status": "limited",
  "rel": { "name": "inventory", "parent": "VM-VOLKSWAGEN-PASSAT-CAR" } }
```

---

## Example queries

All files run against the app indexes unless noted. Full index in
[`opensearch/queries/README.md`](../opensearch/queries/README.md).

### 1. The core protected-search shape — [`11_protected_search_bool_filter.json`](../opensearch/queries/11_protected_search_bool_filter.json)

This mirrors what `backend/src/services/searchService.ts` builds from a validated
request: a `multi_match` for relevance in `must`, business filters in `filter`,
and `must_not` to hide sold-out stock. (The API additionally injects a tenant
filter — a `dealership_id` term for dealership users — from the token, never the
body.)

```json
{
  "query": {
    "bool": {
      "must": [
        { "multi_match": { "query": "suv crew", "fields": ["make", "model", "vehicle_class", "description"] } }
      ],
      "filter": [
        { "term": { "vehicle_class": "suv" } },
        { "term": { "dealership_city": "Las Vegas" } },
        { "range": { "base_daily_rate": { "lte": 90 } } },
        { "range": { "quantity_available": { "gt": 0 } } }
      ],
      "must_not": [{ "term": { "status": "unavailable" } }]
    }
  },
  "sort": [{ "_score": "desc" }, { "base_daily_rate": "asc" }],
  "size": 20
}
```

### 2. How filters narrow the space

Each added `filter` clause prunes the candidate set — the foundation of the scale
story. Start broad and layer constraints:

| add | what it does | file |
|---|---|---|
| `term vehicle_class` | one class only | `01_list_available_suvs.json` |
| `term dealership_city` | one metro | `02_filter_by_dealership_city.json` |
| `range base_daily_rate` | price ceiling | `04_sort_by_base_daily_rate.json` |
| `geo_distance` | within 50 km of a point, nearest first | `03_geo_distance_las_vegas.json` |
| `match description` (BM25) | full-text relevance | `05_search_descriptions_bm25.json` |

### 3. Personalized pricing input — [`06_active_agreements_for_customer.json`](../opensearch/queries/06_active_agreements_for_customer.json)

For a customer search the API runs one agreements query (with `customer_id` from
the token), then applies the best discount per result in-app. Only the six pricing
fields are projected — agreement ids and customer ids never leave the server.

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "customer_id": "CUS-001" } },
        { "term": { "agreement_status": "active" } }
      ]
    }
  }
}
```

### 4. Aggregations — [`08_agg_available_by_vehicle_class.json`](../opensearch/queries/08_agg_available_by_vehicle_class.json)

`"size": 0` + a `terms` agg answers "how much stock per class." On the current
data this returns roughly `car ≈ 2500, suv ≈ 1050, minivan ≈ 150, truck ≈ 90,
van ≈ 5` available units.

### 5. The parent/child alternative — [`12_parent_child_has_parent.json`](../opensearch/queries/12_parent_child_has_parent.json) *(runs on `bench_join`)*

The same "7-seat SUVs in Las Vegas under \$80," but the model attributes live on the
parent, so they move into a `has_parent` join. Identical results to the flat
query, measurably slower at scale — the point of
[`SCALE_AND_JOINS.md`](./SCALE_AND_JOINS.md).

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "dealership_city": "Las Vegas" } },
        { "range": { "base_daily_rate": { "lte": 80 } } },
        {
          "has_parent": {
            "parent_type": "vehicle_model",
            "query": { "bool": { "filter": [
              { "term": { "vehicle_class": "suv" } },
              { "range": { "seats": { "gte": 7 } } }
            ] } }
          }
        }
      ]
    }
  }
}
```
