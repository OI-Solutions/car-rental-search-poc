#!/usr/bin/env python3
"""Ingest the synthetic data files into OpenSearch.

The process is repeatable and idempotent: every document uses its natural id as
the OpenSearch ``_id`` and is written with the bulk ``index`` action, so
rerunning updates documents in place instead of creating duplicates.

Denormalization happens here (not in the source files):
  * `inventory` documents fold in dealership + vehicle-model fields so later
    search needs no joins.
  * `customer_agreements` documents fold in readable customer + dealership names.

Passwords / password hashes are never indexed; `users.json` is not ingested.
"""

from __future__ import annotations

from opensearchpy import helpers

from common import (
    INDEX_CUSTOMER_AGREEMENTS,
    INDEX_CUSTOMERS,
    INDEX_DEALERSHIPS,
    INDEX_INVENTORY,
    INDEX_VEHICLE_MODELS,
    get_client,
    load_source,
)


def _id_map(records, id_field):
    """Return {id_value: record} for quick lookups during denormalization."""
    return {rec[id_field]: rec for rec in records}


def build_dealership_docs(dealerships):
    for d in dealerships:
        yield d["dealership_id"], {
            "dealership_id": d["dealership_id"],
            "name": d["name"],
            "city": d["city"],
            "state": d["state"],
            "location": {"lat": d["latitude"], "lon": d["longitude"]},
        }


def build_vehicle_model_docs(models):
    for m in models:
        # Source fields already match the mapping; pass through unchanged.
        yield m["vehicle_model_id"], dict(m)


def build_inventory_docs(inventory, dealerships_by_id, models_by_id):
    for inv in inventory:
        dlr = dealerships_by_id[inv["dealership_id"]]
        vm = models_by_id[inv["vehicle_model_id"]]
        yield inv["inventory_id"], {
            "inventory_id": inv["inventory_id"],
            # --- denormalized dealership fields ---
            "dealership_id": dlr["dealership_id"],
            "dealership_name": dlr["name"],
            "dealership_city": dlr["city"],
            "dealership_state": dlr["state"],
            "dealership_location": {"lat": dlr["latitude"], "lon": dlr["longitude"]},
            # --- denormalized vehicle-model fields ---
            "vehicle_model_id": vm["vehicle_model_id"],
            "make": vm["make"],
            "model": vm["model"],
            "vehicle_class": vm["vehicle_class"],
            "description": vm["description"],
            "seats": vm["seats"],
            "fuel_type": vm["fuel_type"],
            "transmission": vm["transmission"],
            "cargo_capacity": vm["cargo_capacity"],
            # --- inventory-specific fields ---
            "quantity_available": inv["quantity_available"],
            "base_daily_rate": inv["base_daily_rate"],
            "status": inv["status"],
            "last_updated": inv["last_updated"],
        }


def build_customer_docs(customers):
    for c in customers:
        yield c["customer_id"], dict(c)


def build_agreement_docs(agreements, customers_by_id, dealerships_by_id):
    for a in agreements:
        cust = customers_by_id[a["customer_id"]]
        dlr = dealerships_by_id[a["dealership_id"]]
        yield a["agreement_id"], {
            "agreement_id": a["agreement_id"],
            "customer_id": a["customer_id"],
            "customer_company_name": cust["company_name"],
            "customer_home_city": cust["home_city"],
            "dealership_id": a["dealership_id"],
            "dealership_name": dlr["name"],
            "dealership_city": dlr["city"],
            "vehicle_class": a["vehicle_class"],  # may be null
            "discount_percent": a["discount_percent"],
            "valid_from": a["valid_from"],
            "valid_to": a["valid_to"],
            "agreement_status": a["agreement_status"],
        }


def bulk_index(client, index, docs):
    """Index (id, source) pairs; return the number of documents written."""
    actions = [
        {"_op_type": "index", "_index": index, "_id": doc_id, "_source": source}
        for doc_id, source in docs
    ]
    success, _ = helpers.bulk(client, actions, refresh=True)
    print(f"  {index}: indexed {success} documents")
    return success


def main() -> int:
    client = get_client()

    # Load every source file once.
    dealerships = load_source(INDEX_DEALERSHIPS)
    models = load_source(INDEX_VEHICLE_MODELS)
    inventory = load_source(INDEX_INVENTORY)
    customers = load_source(INDEX_CUSTOMERS)
    agreements = load_source(INDEX_CUSTOMER_AGREEMENTS)

    dealerships_by_id = _id_map(dealerships, "dealership_id")
    models_by_id = _id_map(models, "vehicle_model_id")
    customers_by_id = _id_map(customers, "customer_id")

    print("Ingesting (idempotent, stable _id per document):")
    bulk_index(client, INDEX_DEALERSHIPS, build_dealership_docs(dealerships))
    bulk_index(client, INDEX_VEHICLE_MODELS, build_vehicle_model_docs(models))
    bulk_index(
        client,
        INDEX_INVENTORY,
        build_inventory_docs(inventory, dealerships_by_id, models_by_id),
    )
    bulk_index(client, INDEX_CUSTOMERS, build_customer_docs(customers))
    bulk_index(
        client,
        INDEX_CUSTOMER_AGREEMENTS,
        build_agreement_docs(agreements, customers_by_id, dealerships_by_id),
    )

    print("Ingestion complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
