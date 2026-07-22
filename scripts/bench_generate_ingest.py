#!/usr/bin/env python3
"""Generate a large synthetic-but-realistic corpus and ingest it into TWO indexes
that differ ONLY in how the vehicle-model relationship is physically modeled:

  bench_flat  — denormalized: every inventory doc carries a full copy of its
                vehicle-model fields (make/model/class/seats/fuel/…). One flat doc.
  bench_join  — parent/child: vehicle models are PARENT docs, inventory rows are
                CHILD docs joined via the `join` field (`rel`). Model attributes
                live only on the parent; a query filtering on them must `has_parent`.

Both indexes answer the identical user query and return identical hits — the only
difference is read cost, which scripts/bench_run.py measures.

Data is seeded from the real Cornell listings (distinct make/model/type become the
~550 real vehicle models; metros are sampled by real listing density) and expanded
with deterministic variation to the target row count. Streaming + parallel_bulk
keep memory flat regardless of target size.

Usage:
  python scripts/bench_generate_ingest.py [--target 2000000] [--branches 6]
"""

from __future__ import annotations

import argparse
import bisect
import csv
import random
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

from opensearchpy import helpers

from common import MAPPINGS_DIR, get_client, load_json

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "source" / "CarRentalDataV1.csv"
SEED = 42
BASE_DATE = date(2026, 1, 1)

INDEX_FLAT = "bench_flat"
INDEX_JOIN = "bench_join"

CLASS_SPECS = {
    "car":     (5, "Efficient passenger car for client visits and daily business travel."),
    "suv":     (7, "Three-row SUV for crews, mixed terrain, and passenger-plus-cargo flexibility."),
    "minivan": (7, "Seven-seat minivan for group transport and light cargo runs."),
    "truck":   (5, "Pickup truck for tools, equipment, jobsite travel, and light towing."),
    "van":     (2, "High-roof cargo van for deliveries, service equipment, and mobile operations."),
}


def slug(*p: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in "-".join(p).upper()).strip("-")


def fnum(v: str, d: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def build_models_and_metros(csv_path: Path):
    """Return (models, metros): real vehicle models as join parents, and metros
    with centroids + selection weights proportional to real listing density."""
    with open(csv_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    rate_sum: dict[tuple, float] = defaultdict(float)
    rate_n: dict[tuple, int] = defaultdict(int)
    fuel_votes: dict[tuple, Counter] = defaultdict(Counter)
    for r in rows:
        key = ((r["vehicle.make"] or "Unknown").strip(),
               (r["vehicle.model"] or "Unknown").strip(),
               (r["vehicle.type"] or "car").strip().lower())
        rate = fnum(r["rate.daily"])
        if rate > 0:
            rate_sum[key] += rate
            rate_n[key] += 1
            fuel_votes[key][(r.get("fuelType") or "unknown").strip().lower() or "unknown"] += 1

    models = []
    seen: set[str] = set()
    for key in sorted(rate_n):
        make, model, vclass = key
        vmid = f"VM-{slug(make, model, vclass)}"[:120]
        while vmid in seen:
            vmid += "-x"
        seen.add(vmid)
        seats, blurb = CLASS_SPECS.get(vclass, (5, "Rental vehicle for business use."))
        models.append({
            "vehicle_model_id": vmid,
            "make": make, "model": model, "vehicle_class": vclass,
            "seats": seats, "fuel_type": fuel_votes[key].most_common(1)[0][0],
            "transmission": "automatic",
            "description": f"{make} {model}. {blurb}",
            "mean_rate": rate_sum[key] / rate_n[key],
        })

    metro_agg: dict[tuple, list] = defaultdict(lambda: [0, 0.0, 0.0])
    for r in rows:
        city, state = r["location.city"].strip(), r["location.state"].strip()
        if city and state:
            a = metro_agg[(city, state)]
            a[0] += 1
            a[1] += fnum(r["location.latitude"])
            a[2] += fnum(r["location.longitude"])
    metros = [{
        "city": city, "state": state, "weight": n,
        "lat": round(lat / n, 4), "lon": round(lon / n, 4),
    } for (city, state), (n, lat, lon) in metro_agg.items()]
    metros.sort(key=lambda m: (-m["weight"], m["state"], m["city"]))
    return models, metros


def cumulative(weights: list[float]) -> list[float]:
    acc, out = 0.0, []
    for w in weights:
        acc += w
        out.append(acc)
    return out


def recreate_index(client, name: str, mapping_file: str) -> None:
    if client.indices.exists(index=name):
        client.indices.delete(index=name)
    client.indices.create(index=name, body=load_json(MAPPINGS_DIR / mapping_file))
    print(f"created index '{name}'")


def gen_actions(models, metros, target: int, branches: int):
    """Yield bulk actions for BOTH indexes from one deterministic pass."""
    rnd = random.Random(SEED)
    # Models are already de-duplicated, so pick uniformly across them; metros are
    # picked weighted by real listing density so the geography stays realistic.
    pop_cum = cumulative([1.0 for _ in models])
    metro_cum = cumulative([m["weight"] for m in metros])
    metro_total = metro_cum[-1]
    model_total = pop_cum[-1]

    for i in range(target):
        m = models[bisect.bisect_left(pop_cum, rnd.random() * model_total)]
        mid = m["vehicle_model_id"]
        metro = metros[bisect.bisect_left(metro_cum, rnd.random() * metro_total)]
        branch = rnd.randint(1, branches)
        did = f"DLR-{slug(metro['state'], metro['city'])}-{branch:02d}"
        rate = max(15.0, round(m["mean_rate"] * rnd.uniform(0.7, 1.4)))
        qty = rnd.randint(0, 5)
        status = "unavailable" if qty == 0 else "limited" if qty <= 2 else "available"
        inv_id = f"INV-{i:08d}"
        child = {
            "inventory_id": inv_id,
            "dealership_id": did,
            "dealership_name": f"{metro['city']} Fleet {branch:02d}",
            "dealership_city": metro["city"],
            "dealership_state": metro["state"],
            "dealership_location": {"lat": round(metro["lat"] + rnd.uniform(-0.05, 0.05), 4),
                                     "lon": round(metro["lon"] + rnd.uniform(-0.05, 0.05), 4)},
            "year": rnd.randint(2006, 2020),
            "quantity_available": qty,
            "base_daily_rate": rate,
            "status": status,
            "last_updated": (BASE_DATE + timedelta(days=rnd.randint(0, 180))).isoformat(),
        }
        model_fields = {
            "vehicle_model_id": mid, "make": m["make"], "model": m["model"],
            "vehicle_class": m["vehicle_class"], "description": m["description"],
            "seats": m["seats"], "fuel_type": m["fuel_type"], "transmission": m["transmission"],
        }
        # Denormalized flat doc: model fields folded in.
        yield {"_index": INDEX_FLAT, "_id": inv_id, "_source": {**child, **model_fields}}
        # Join child doc: model fields live on the parent, not here. Route to parent.
        yield {"_index": INDEX_JOIN, "_id": inv_id, "routing": mid,
               "_source": {**child, "rel": {"name": "inventory", "parent": mid}}}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", type=int, default=2_000_000)
    ap.add_argument("--branches", type=int, default=6)
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    args = ap.parse_args()

    if not args.csv.exists():
        raise SystemExit(f"ERROR: {args.csv} not found (see HANDOFF 'Data provenance').")

    client = get_client()
    models, metros = build_models_and_metros(args.csv)
    print(f"models (join parents): {len(models)}   metros: {len(metros)}   "
          f"target inventory rows: {args.target:,}")

    recreate_index(client, INDEX_FLAT, "bench_flat.json")
    recreate_index(client, INDEX_JOIN, "bench_join.json")

    # Parents go into the join index first (children reference them by routing).
    parent_actions = [{
        "_index": INDEX_JOIN, "_id": m["vehicle_model_id"], "routing": m["vehicle_model_id"],
        "_source": {k: v for k, v in m.items() if k != "mean_rate"} | {"rel": "vehicle_model"},
    } for m in models]
    helpers.bulk(client, parent_actions, chunk_size=1000, request_timeout=120)
    print(f"indexed {len(models)} vehicle-model parents into {INDEX_JOIN}")

    t0 = time.time()
    done = 0
    for ok, item in helpers.parallel_bulk(
        client, gen_actions(models, metros, args.target, args.branches),
        thread_count=4, chunk_size=4000, queue_size=8, raise_on_error=False, request_timeout=180,
    ):
        if not ok:
            print("bulk error:", item)
        done += 1
        if done % 400_000 == 0:
            rate = done / (time.time() - t0)
            print(f"  ...{done:,} actions ({rate:,.0f}/s)  elapsed {time.time()-t0:,.0f}s")
    print(f"ingest actions completed: {done:,} in {time.time()-t0:,.0f}s")

    for name in (INDEX_FLAT, INDEX_JOIN):
        client.indices.put_settings(index=name, body={"index": {"refresh_interval": "1s"}})
        client.indices.refresh(index=name)
        cnt = client.count(index=name)["count"]
        print(f"{name}: {cnt:,} docs")
    print("Done. Run: python scripts/bench_run.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
