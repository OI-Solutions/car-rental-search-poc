#!/usr/bin/env python3
"""Validate the synthetic B2B car-rental search dataset."""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"


def load(name: str) -> list[dict]:
    path = DATA_DIR / name
    if not path.exists():
        raise FileNotFoundError(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"{name} must contain a JSON array")
    return value


def require_unique(rows: list[dict], field: str, label: str) -> None:
    values = [row[field] for row in rows]
    duplicates = [value for value, count in Counter(values).items() if count > 1]
    if duplicates:
        raise ValueError(f"Duplicate {label} {field} values: {duplicates}")


def main() -> int:
    dealerships = load("dealerships.json")
    models = load("vehicle_models.json")
    inventory = load("inventory.json")
    customers = load("customers.json")
    agreements = load("agreements.json")
    users = load("users.json")

    require_unique(dealerships, "dealership_id", "dealership")
    require_unique(models, "vehicle_model_id", "vehicle model")
    require_unique(inventory, "inventory_id", "inventory")
    require_unique(customers, "customer_id", "customer")
    require_unique(agreements, "agreement_id", "agreement")
    require_unique(users, "user_id", "user")

    dealership_ids = {row["dealership_id"] for row in dealerships}
    model_ids = {row["vehicle_model_id"] for row in models}
    customer_ids = {row["customer_id"] for row in customers}
    model_classes = {row["vehicle_class"] for row in models}

    for row in inventory:
        assert row["dealership_id"] in dealership_ids, row
        assert row["vehicle_model_id"] in model_ids, row
        assert row["quantity_available"] >= 0, row
        assert row["base_daily_rate"] > 0, row

    agreements_per_customer: dict[str, set[str]] = defaultdict(set)
    discounts_per_customer: dict[str, list[float]] = defaultdict(list)

    for row in agreements:
        assert row["customer_id"] in customer_ids, row
        assert row["dealership_id"] in dealership_ids, row
        assert row["vehicle_class"] is None or row["vehicle_class"] in model_classes, row
        assert 0 <= row["discount_percent"] <= 100, row
        agreements_per_customer[row["customer_id"]].add(row["dealership_id"])
        discounts_per_customer[row["customer_id"]].append(row["discount_percent"])

    for customer_id in customer_ids:
        count = len(agreements_per_customer[customer_id])
        assert 2 <= count <= 4, (customer_id, count)

    assert any(
        max(discounts) - min(discounts) >= 15
        for discounts in discounts_per_customer.values()
        if discounts
    ), "Expected at least one customer with substantially different discounts"

    for row in users:
        role = row["role"]
        if role == "customer_user":
            assert row["customer_id"] in customer_ids
            assert row["dealership_id"] is None
        elif role == "dealership_user":
            assert row["dealership_id"] in dealership_ids
            assert row["customer_id"] is None
        elif role == "corporate_admin":
            assert row["customer_id"] is None
            assert row["dealership_id"] is None
        else:
            raise AssertionError(f"Unknown role: {role}")

    # Demonstrate an intentional price inversion somewhere in the data: a case
    # where the dealership with the lowest *base* rate for a model is not the
    # cheapest once a customer's negotiated discount is applied. This is the
    # core reason personalized search cannot just sort on base_daily_rate.
    # Discounts are resolved dealership-wide here (the class-specific tiers only
    # sharpen the effect), mirroring backend pricingService's fallback.
    dealership_city = {d["dealership_id"]: d["city"] for d in dealerships}
    wide_discount: dict[tuple[str, str], float] = {}
    for row in agreements:
        if row["agreement_status"] == "active" and row["vehicle_class"] is None:
            key = (row["customer_id"], row["dealership_id"])
            wide_discount[key] = max(wide_discount.get(key, 0.0), row["discount_percent"])

    min_base: dict[tuple[str, str], float] = {}
    for row in inventory:
        key = (row["dealership_id"], row["vehicle_model_id"])
        rate = row["base_daily_rate"]
        if key not in min_base or rate < min_base[key]:
            min_base[key] = rate

    inversion = None
    for customer_id in sorted(customer_ids):
        dealers = sorted({d for (c, d) in wide_discount if c == customer_id})
        if len(dealers) < 2:
            continue
        rates_by_model: dict[str, dict[str, float]] = defaultdict(dict)
        for (dlr, model_id), rate in min_base.items():
            if dlr in dealers:
                rates_by_model[model_id][dlr] = rate
        for model_id, per_dealer in rates_by_model.items():
            if len(per_dealer) < 2:
                continue
            base_best = min(per_dealer, key=per_dealer.get)
            def net(dlr: str) -> float:
                return per_dealer[dlr] * (1 - wide_discount.get((customer_id, dlr), 0.0) / 100)
            pers_best = min(per_dealer, key=net)
            if base_best != pers_best:
                inversion = (
                    f"{customer_id}: {model_id} cheapest base at "
                    f"{dealership_city[base_best]} (${per_dealer[base_best]:.2f}) but "
                    f"cheapest personalized at {dealership_city[pers_best]} "
                    f"(${net(pers_best):.2f} vs ${net(base_best):.2f})"
                )
                break
        if inversion:
            break

    assert inversion is not None, "Expected at least one base-vs-personalized price inversion"

    print("Validation passed.")
    print(f"Dealerships: {len(dealerships)}")
    print(f"Vehicle models: {len(models)}")
    print(f"Inventory records: {len(inventory)}")
    print(f"Customers: {len(customers)}")
    print(f"Agreements: {len(agreements)}")
    print(f"Users: {len(users)}")
    print(f"Price inversion example: {inversion}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, FileNotFoundError, KeyError, ValueError) as exc:
        print(f"Validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
