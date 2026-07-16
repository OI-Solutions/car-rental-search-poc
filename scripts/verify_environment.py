#!/usr/bin/env python3
"""Verify the ingested environment matches the source data and works.

Two checks:
  1. Document counts per index equal the number of records in each source file.
  2. A handful of representative queries return sensible results (proves the
     mappings, geo_point, BM25 text search, and aggregations all function).

Exits non-zero if any count mismatches so it can be used in scripts/CI.
"""

from __future__ import annotations

from common import (
    ALL_INDEXES,
    INDEX_CUSTOMER_AGREEMENTS,
    INDEX_INVENTORY,
    get_client,
    load_source,
)

# Chicago dealership coordinates (for the geo-distance smoke test).
CHICAGO_LAT, CHICAGO_LON = 41.8781, -87.6298


def check_counts(client) -> bool:
    print("Document count verification")
    print("-" * 52)
    print(f"{'index':<24}{'source':>10}{'indexed':>10}  result")
    all_ok = True
    for index in ALL_INDEXES:
        expected = len(load_source(index))
        client.indices.refresh(index=index)
        actual = client.count(index=index)["count"]
        ok = expected == actual
        all_ok = all_ok and ok
        print(f"{index:<24}{expected:>10}{actual:>10}  {'PASS' if ok else 'FAIL'}")
    print("-" * 52)
    print("counts:", "ALL PASS" if all_ok else "MISMATCH DETECTED")
    return all_ok


def smoke_queries(client) -> None:
    print("\nSample query smoke tests")
    print("-" * 52)

    # Available SUVs.
    res = client.search(
        index=INDEX_INVENTORY,
        body={
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"vehicle_class": "suv"}},
                        {"term": {"status": "available"}},
                    ]
                }
            }
        },
        size=0,
    )
    print(f"available SUVs .......................... {res['hits']['total']['value']} hits")

    # Geo-distance around Chicago (50km).
    res = client.search(
        index=INDEX_INVENTORY,
        body={
            "query": {
                "geo_distance": {
                    "distance": "50km",
                    "dealership_location": {"lat": CHICAGO_LAT, "lon": CHICAGO_LON},
                }
            }
        },
        size=0,
    )
    print(f"inventory within 50km of Chicago ........ {res['hits']['total']['value']} hits")

    # BM25 description search.
    res = client.search(
        index=INDEX_INVENTORY,
        body={"query": {"match": {"description": "cargo delivery equipment"}}},
        size=1,
    )
    top = res["hits"]["hits"]
    top_desc = top[0]["_source"]["make"] + " " + top[0]["_source"]["model"] if top else "n/a"
    print(f"BM25 'cargo delivery equipment' top hit . {top_desc}")

    # Active agreements for one customer.
    res = client.search(
        index=INDEX_CUSTOMER_AGREEMENTS,
        body={
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"customer_id": "CUS-001"}},
                        {"term": {"agreement_status": "active"}},
                    ]
                }
            }
        },
        size=0,
    )
    print(f"active agreements for CUS-001 ........... {res['hits']['total']['value']} hits")

    # Aggregate available quantity by vehicle class.
    res = client.search(
        index=INDEX_INVENTORY,
        body={
            "aggs": {
                "by_class": {
                    "terms": {"field": "vehicle_class", "size": 20},
                    "aggs": {"available": {"sum": {"field": "quantity_available"}}},
                }
            }
        },
        size=0,
    )
    buckets = res["aggregations"]["by_class"]["buckets"]
    summary = ", ".join(
        f"{b['key']}={int(b['available']['value'])}" for b in buckets
    )
    print(f"available qty by class .................. {summary}")
    print("-" * 52)


def main() -> int:
    client = get_client()
    counts_ok = check_counts(client)
    smoke_queries(client)
    if not counts_ok:
        print("\nVERIFICATION FAILED: document counts do not match source data.")
        return 1
    print("\nVERIFICATION PASSED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
