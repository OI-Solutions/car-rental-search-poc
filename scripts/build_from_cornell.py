#!/usr/bin/env python3
"""Build the normalized POC source files from the Cornell Car Rental dataset.

The Cornell dataset (Kaggle: kushleshkumar/cornell-car-rental-dataset) is a flat
list of ~5,851 individual Turo listings. It has real vehicles, prices, fuel
types, and locations, but NO B2B structure: no dealerships, customers, negotiated
agreements, or tiered pricing. That tenant/pricing layer is exactly what this POC
demonstrates and what no public dataset provides, so we synthesize it on top.

This script produces the five *normalized* source files the rest of the project
already consumes (scripts/ingest_data.py and backend fixtureClient denormalize
them identically), so nothing downstream changes:

  dealerships.json      top-N metros, each a "dealership" (fleet) with a centroid
  vehicle_models.json   distinct (make, model, class) with synthesized specs
  inventory.json        one row per real Cornell listing in a kept metro
  customers.json        the existing 12 synthetic B2B customers (re-homed to metros)
  agreements.json       regenerated tiered discounts referencing the new metros
  users.json            logins realigned to the new dealership ids

Everything is deterministic (fixed SEED + stable hashing) so reruns are stable.

Usage:
  python scripts/build_from_cornell.py [--csv data/source/CarRentalDataV1.csv]
                                       [--metros 12]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DEFAULT_CSV = DATA_DIR / "source" / "CarRentalDataV1.csv"
SEED = 42

# One customer is intentionally kept fully inactive (login disabled, every
# agreement inactive). It exercises the 403-on-inactive-user path and the
# "inactive agreements are never priced" path, and the tests guard both.
INACTIVE_CUSTOMER = "CUS-012"

# Per-vehicle-class specs the Cornell data does not carry. vehicle_class is a
# free-form keyword in the mappings, so these five Cornell types pass straight
# through; we just attach plausible, class-consistent detail fields.
CLASS_SPECS = {
    "car":     {"seats": 5, "cargo_capacity": "13 cu ft",  "blurb": "Efficient passenger car for client visits and daily business travel."},
    "suv":     {"seats": 7, "cargo_capacity": "80 cu ft",  "blurb": "Three-row SUV for crews, mixed terrain, and passenger-plus-cargo flexibility."},
    "minivan": {"seats": 7, "cargo_capacity": "140 cu ft", "blurb": "Seven-seat minivan for group transport and light cargo runs."},
    "truck":   {"seats": 5, "cargo_capacity": "5.5 ft bed", "blurb": "Pickup truck for tools, equipment, jobsite travel, and light towing."},
    "van":     {"seats": 2, "cargo_capacity": "400 cu ft", "blurb": "High-roof cargo van for deliveries, service equipment, and mobile operations."},
}
DEFAULT_SPEC = {"seats": 5, "cargo_capacity": "n/a", "blurb": "Rental vehicle for business use."}


def stable_int(*parts: object) -> int:
    """Deterministic non-negative int from any inputs (Python's hash() is salted)."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:8], 16)


def slug(*parts: str) -> str:
    raw = "-".join(parts)
    return "".join(c if c.isalnum() else "-" for c in raw.upper()).strip("-")


def load_rows(csv_path: Path) -> list[dict]:
    if not csv_path.exists():
        raise SystemExit(
            f"ERROR: {csv_path} not found.\n"
            "Download the Cornell Car Rental dataset from\n"
            "  https://www.kaggle.com/datasets/kushleshkumar/cornell-car-rental-dataset\n"
            f"and unzip CarRentalDataV1.csv into {csv_path.parent}/."
        )
    with open(csv_path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def fnum(v: str, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Builders                                                                     #
# --------------------------------------------------------------------------- #
def build_dealerships(rows: list[dict], n_metros: int):
    """Top-N (city, state) metros become dealerships; location is the centroid."""
    by_metro: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        city, state = r["location.city"].strip(), r["location.state"].strip()
        if city and state:
            by_metro[(city, state)].append(r)

    top = sorted(by_metro.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:n_metros]

    dealerships = []
    metro_to_id: dict[tuple[str, str], str] = {}
    for (city, state), listings in top:
        did = f"DLR-{slug(state, city)}"
        metro_to_id[(city, state)] = did
        lat = sum(fnum(x["location.latitude"]) for x in listings) / len(listings)
        lon = sum(fnum(x["location.longitude"]) for x in listings) / len(listings)
        dealerships.append({
            "dealership_id": did,
            "name": f"{city} Fleet Center",
            "city": city,
            "state": state,
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
        })
    dealerships.sort(key=lambda d: d["dealership_id"])
    return dealerships, metro_to_id


def model_key(r: dict) -> tuple[str, str, str]:
    make = (r["vehicle.make"] or "Unknown").strip()
    model = (r["vehicle.model"] or "Unknown").strip()
    vclass = (r["vehicle.type"] or "car").strip().lower()
    return make, model, vclass


def fuel_of(r: dict) -> str:
    f = (r.get("fuelType") or "").strip().lower()
    return f or "unknown"


def build_vehicle_models(kept: list[dict]):
    """Distinct (make, model, class); fuel_type = the model's most common fuel."""
    fuel_votes: dict[tuple[str, str, str], Counter] = defaultdict(Counter)
    for r in kept:
        fuel_votes[model_key(r)][fuel_of(r)] += 1

    models = []
    key_to_id: dict[tuple[str, str, str], str] = {}
    seen: set[str] = set()
    for key in sorted(fuel_votes):
        make, model, vclass = key
        vmid = f"VM-{slug(make, model, vclass)}"[:120]
        while vmid in seen:  # guard against slug collisions
            vmid = f"{vmid}-{stable_int(vmid) % 100:02d}"
        seen.add(vmid)
        key_to_id[key] = vmid
        spec = CLASS_SPECS.get(vclass, DEFAULT_SPEC)
        models.append({
            "vehicle_model_id": vmid,
            "make": make,
            "model": model,
            "vehicle_class": vclass,
            "seats": spec["seats"],
            "cargo_capacity": spec["cargo_capacity"],
            "transmission": "automatic",
            "fuel_type": fuel_votes[key].most_common(1)[0][0],
            "description": f"{make} {model}. {spec['blurb']}",
        })
    return models, key_to_id


def build_inventory(kept: list[dict], metro_to_id, key_to_id):
    """One inventory row per real listing, referencing its metro + model."""
    base = date(2026, 7, 1)
    seq: dict[str, int] = defaultdict(int)
    inventory = []
    for r in kept:
        did = metro_to_id[(r["location.city"].strip(), r["location.state"].strip())]
        vmid = key_to_id[model_key(r)]
        seq[did] += 1
        inv_id = f"INV-{did[4:]}-{seq[did]:04d}"
        # Deterministic small fleet counts; a few show as sold-out.
        qty = stable_int(inv_id, "qty") % 6  # 0..5
        status = "unavailable" if qty == 0 else "limited" if qty <= 2 else "available"
        day_offset = stable_int(inv_id, "day") % 20
        inventory.append({
            "inventory_id": inv_id,
            "dealership_id": did,
            "vehicle_model_id": vmid,
            "quantity_available": qty,
            "base_daily_rate": round(fnum(r["rate.daily"]), 2),
            "status": status,
            "last_updated": (base + timedelta(days=day_offset)).isoformat() + "T12:00:00Z",
        })
    return inventory


def build_customers(dealerships: list[dict]):
    """Reuse the existing 12 B2B customers, re-homing each to a real metro."""
    existing = json.loads((DATA_DIR / "customers.json").read_text())
    cities = [d["city"] for d in dealerships]
    for i, c in enumerate(existing):
        c["home_city"] = cities[i % len(cities)]
    return existing


def build_agreements(customers, dealerships, models):
    """Regenerate tiered discounts across the new metros.

    Each customer gets agreements at 2-4 dealerships (satisfies validate_data),
    a mix of dealership-wide (vehicle_class=null) and class-specific tiers, with
    discounts spread widely enough that at least one customer spans >=15 points.
    """
    rnd = random.Random(SEED)
    did_list = [d["dealership_id"] for d in dealerships]
    classes = sorted({m["vehicle_class"] for m in models})

    agreements = []
    n = 0
    for ci, c in enumerate(customers):
        k = 2 + (stable_int(c["customer_id"]) % 3)  # 2..4 dealerships
        # Deterministic spread of dealerships across the metro list.
        start = stable_int(c["customer_id"], "start") % len(did_list)
        step = 1 + (stable_int(c["customer_id"], "step") % max(1, len(did_list) - 1))
        chosen = []
        idx = start
        while len(chosen) < min(k, len(did_list)):
            did = did_list[idx % len(did_list)]
            if did not in chosen:
                chosen.append(did)
            idx += step

        for j, did in enumerate(chosen):
            # First dealership is the "primary" account: a strong dealership-wide
            # discount. Others mix a modest base discount with a class-specific tier.
            if j == 0:
                base_disc = 25 + (stable_int(c["customer_id"], did) % 11)  # 25..35
                n += 1
                agreements.append(_agr(n, c, did, None, base_disc))
            else:
                base_disc = 3 + (stable_int(c["customer_id"], did, "w") % 8)  # 3..10
                n += 1
                agreements.append(_agr(n, c, did, None, base_disc))
                vclass = classes[stable_int(c["customer_id"], did, "vc") % len(classes)]
                tier_disc = 12 + (stable_int(c["customer_id"], did, "t") % 14)  # 12..25
                n += 1
                agreements.append(_agr(n, c, did, vclass, tier_disc))

    # The inactive customer's agreements exist (so it still has 2-4 dealership
    # relationships) but are all inactive, so they never contribute to pricing.
    for a in agreements:
        if a["customer_id"] == INACTIVE_CUSTOMER:
            a["agreement_status"] = "inactive"
    return agreements


def _agr(n, c, did, vclass, disc):
    return {
        "agreement_id": f"AGR-{n:04d}",
        "customer_id": c["customer_id"],
        "dealership_id": did,
        "vehicle_class": vclass,
        "discount_percent": float(disc),
        "valid_from": "2026-01-01",
        "valid_to": "2026-12-31",
        "agreement_status": "active",
    }


def build_users(customers, dealerships):
    """12 customer logins (reused) + one login per dealership + 2 corporate admins."""
    users = []
    for c in customers:
        handle = "".join(ch for ch in c["company_name"].lower() if ch.isalnum() or ch == " ").replace(" ", ".")
        users.append({
            "user_id": f"USR-{c['customer_id'][-3:]}-C",
            "email": f"{handle}@example.test",
            "role": "customer_user",
            "customer_id": c["customer_id"],
            "dealership_id": None,
            "status": "inactive" if c["customer_id"] == INACTIVE_CUSTOMER else "active",
        })
    for i, d in enumerate(dealerships, 1):
        users.append({
            "user_id": f"USR-D{i:02d}",
            "email": f"fleet.{d['dealership_id'][4:].lower().replace('-', '.')}@example.test",
            "role": "dealership_user",
            "customer_id": None,
            "dealership_id": d["dealership_id"],
            "status": "active",
        })
    for i in (1, 2):
        users.append({
            "user_id": f"USR-ADM-{i:02d}",
            "email": f"corporate.admin{i}@example.test",
            "role": "corporate_admin",
            "customer_id": None,
            "dealership_id": None,
            "status": "active",
        })
    return users


def write_json(name: str, rows) -> None:
    (DATA_DIR / name).write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def report_price_inversion(inventory, agreements, dealerships):
    """Find a demo-worthy case: cheapest base rate != cheapest personalized."""
    # class-aware discount resolution, mirroring backend pricingService.
    wide: dict[tuple[str, str], float] = {}
    byclass: dict[tuple[str, str, str], float] = {}
    for a in agreements:
        if a["agreement_status"] != "active":
            continue
        key = (a["customer_id"], a["dealership_id"])
        if a["vehicle_class"] is None:
            wide[key] = max(wide.get(key, 0), a["discount_percent"])
        else:
            k2 = (*key, a["vehicle_class"])
            byclass[k2] = max(byclass.get(k2, 0), a["discount_percent"])

    dname = {d["dealership_id"]: d["city"] for d in dealerships}
    customers = sorted({a["customer_id"] for a in agreements})
    classes = sorted({inv_class for inv_class in (i.get("_c") for i in [])})  # placeholder
    # min base rate per (dealership, model-class) — approximate class via model id prefix isn't
    # available here, so compare per model across dealerships instead.
    from collections import defaultdict as dd
    rate_by = dd(list)  # (dealership, model) -> [rates]
    for i in inventory:
        rate_by[(i["dealership_id"], i["vehicle_model_id"])].append(i["base_daily_rate"])

    # Look for a customer + model available at >=2 of their dealerships where the
    # personalized ranking flips vs base ranking. (vehicle_class of the model is
    # not in inventory, so class-specific tiers are approximated as dealership-wide.)
    for cust in customers:
        cust_dealers = [d for (cc, d) in wide if cc == cust] + [d for (cc, d, _) in byclass if cc == cust]
        cust_dealers = sorted(set(cust_dealers))
        if len(cust_dealers) < 2:
            continue
        models_here = dd(dict)
        for (did, vm), rates in rate_by.items():
            if did in cust_dealers:
                models_here[vm][did] = min(rates)
        for vm, per in models_here.items():
            if len(per) < 2:
                continue
            base_best = min(per, key=per.get)
            def personalized(did):
                disc = wide.get((cust, did), 0.0)
                return per[did] * (1 - disc / 100)
            pers_best = min(per, key=personalized)
            if base_best != pers_best:
                return (
                    f"{cust}: model {vm} cheapest base at {dname[base_best]} "
                    f"(${per[base_best]:.2f}) but cheapest *personalized* at "
                    f"{dname[pers_best]} (${personalized(pers_best):.2f} vs "
                    f"${personalized(base_best):.2f})"
                )
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    ap.add_argument("--metros", type=int, default=12)
    args = ap.parse_args()

    random.seed(SEED)
    rows = load_rows(args.csv)

    dealerships, metro_to_id = build_dealerships(rows, args.metros)
    kept = [
        r for r in rows
        if (r["location.city"].strip(), r["location.state"].strip()) in metro_to_id
        and fnum(r["rate.daily"]) > 0
    ]
    models, key_to_id = build_vehicle_models(kept)
    inventory = build_inventory(kept, metro_to_id, key_to_id)
    customers = build_customers(dealerships)
    agreements = build_agreements(customers, dealerships, models)
    users = build_users(customers, dealerships)

    write_json("dealerships.json", dealerships)
    write_json("vehicle_models.json", models)
    write_json("inventory.json", inventory)
    write_json("customers.json", customers)
    write_json("agreements.json", agreements)
    write_json("users.json", users)

    print("Built normalized POC dataset from Cornell:")
    print(f"  dealerships    : {len(dealerships)} (top {args.metros} metros)")
    print(f"  vehicle_models : {len(models)}")
    print(f"  inventory      : {len(inventory)} (of {len(rows)} listings)")
    print(f"  customers      : {len(customers)}")
    print(f"  agreements     : {len(agreements)}")
    print(f"  users          : {len(users)}")
    inv = report_price_inversion(inventory, agreements, dealerships)
    print("  price inversion: " + (inv or "none found (consider adjusting discounts)"))


if __name__ == "__main__":
    main()
