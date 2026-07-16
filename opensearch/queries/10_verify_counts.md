# 10. Verify indexed document counts match the source data

This check is automated by `scripts/verify_environment.py`, which compares each
index's document count against the number of records in its source JSON file and
fails if any differ.

## Expected counts

| Index                 | Source file            | Expected docs |
| --------------------- | ---------------------- | ------------- |
| `dealerships`         | `dealerships.json`     | 5             |
| `vehicle_models`      | `vehicle_models.json`  | 5             |
| `inventory`           | `inventory.json`       | 50            |
| `customers`           | `customers.json`       | 12            |
| `customer_agreements` | `agreements.json`      | 36            |

## Manual equivalents (Dashboards Dev Tools or curl)

Count a single index:

```
GET inventory/_count
```

Count all POC indexes at once:

```
GET dealerships,vehicle_models,inventory,customers,customer_agreements/_count
```

Per-index breakdown via the cat API:

```
GET _cat/indices/dealerships,vehicle_models,inventory,customers,customer_agreements?v&h=index,docs.count
```

curl form (self-signed cert → `-k`):

```
curl -sk -u "$OPENSEARCH_USERNAME:$OPENSEARCH_PASSWORD" \
  "https://localhost:9200/inventory/_count"
```
