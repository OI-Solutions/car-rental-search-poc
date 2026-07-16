# Sample queries

Each `.json` file is a **pure OpenSearch request body** (no comments — the
`_search` API rejects unknown keys). Run one against the index listed below in
**Dashboards → Dev Tools → Console**:

```
GET inventory/_search
{ ...paste the file contents... }
```

…or with curl from the project root (self-signed cert → `-k`):

```bash
curl -sk -u "admin:$OPENSEARCH_PASSWORD" \
  "https://localhost:9200/inventory/_search" \
  -H 'Content-Type: application/json' \
  -d @opensearch/queries/01_list_available_suvs.json
```

| File | Endpoint | Demonstrates |
| ---- | -------- | ------------ |
| `01_list_available_suvs.json` | `inventory/_search` | List available SUVs, cheapest first |
| `02_filter_by_dealership_city.json` | `inventory/_search` | Filter inventory by dealership city (edit the city) |
| `03_geo_distance_chicago.json` | `inventory/_search` | Inventory within 50 km of Chicago, nearest first |
| `04_sort_by_base_daily_rate.json` | `inventory/_search` | All inventory sorted by base daily rate |
| `05_search_descriptions_bm25.json` | `inventory/_search` | BM25 full-text search over vehicle descriptions |
| `06_active_agreements_for_customer.json` | `customer_agreements/_search` | Active agreements for one customer (edit `customer_id`) |
| `07_agreements_for_dealership.json` | `customer_agreements/_search` | Agreements for one dealership (edit `dealership_id`) |
| `08_agg_available_by_vehicle_class.json` | `inventory/_search` | Aggregate available inventory by vehicle class |
| `09_agg_inventory_by_dealership.json` | `inventory/_search` | Aggregate inventory by dealership |
| `10_verify_counts.md` | `_count` / `_cat` | Verify indexed document counts vs source data |

> Files 08 and 09 use `"size": 0` — results are in the `aggregations` block, not
> `hits`. File 10 is documentation for the count checks automated by
> `scripts/verify_environment.py`.
