#!/usr/bin/env python3
"""Benchmark denormalized (bench_flat) vs parent/child (bench_join) retrieval.

Runs a ladder of increasingly selective searches against BOTH indexes. Each rung
adds a filter, so the candidate space narrows — the "filters improve search"
story — while the parent/child index pays a join tax the flat index does not.

For every query we assert flat and join return the SAME hit count (proving the two
models are equivalent in result, different only in cost), then report p50/p95 of
the server-side `took`. We also capture index store sizes and post-run fielddata
heap (join global ordinals) so the read-vs-write trade-off is shown honestly.

Output: prints a table and writes scripts/bench_results.json (consumed by the
chart artifact and docs/SCALE_AND_JOINS.md).

Usage: python scripts/bench_run.py [--iterations 30] [--city "Las Vegas"]
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from common import get_client

INDEX_FLAT = "bench_flat"
INDEX_JOIN = "bench_join"
OUT = Path(__file__).resolve().parent / "bench_results.json"


def flat_query(stage: int, city: str):
    """bool.filter with all constraints inline on the denormalized doc."""
    f = []
    if stage >= 1: f.append({"term": {"vehicle_class": "suv"}})
    if stage >= 2: f.append({"term": {"dealership_city": city}})
    if stage >= 3: f.append({"range": {"base_daily_rate": {"lte": 80}}})
    if stage >= 4: f.append({"range": {"seats": {"gte": 7}}})
    return {"query": {"bool": {"filter": f}}} if f else {"query": {"match_all": {}}}


def join_query(stage: int, city: str):
    """Same constraints, but model attributes (class, seats) require has_parent."""
    child, parent = [], []
    if stage >= 1: parent.append({"term": {"vehicle_class": "suv"}})
    if stage >= 2: child.append({"term": {"dealership_city": city}})
    if stage >= 3: child.append({"range": {"base_daily_rate": {"lte": 80}}})
    if stage >= 4: parent.append({"range": {"seats": {"gte": 7}}})
    f = list(child)
    if parent:
        f.append({"has_parent": {"parent_type": "vehicle_model",
                                  "query": {"bool": {"filter": parent}}}})
    else:
        # stage 0: only real inventory children, not the parent docs.
        f.append({"term": {"rel": "inventory"}})
    return {"query": {"bool": {"filter": f}}}


STAGES = [
    (0, "match_all (all inventory)"),
    (1, "+ class=suv"),
    (2, "+ city"),
    (3, "+ price<=80"),
    (4, "+ seats>=7"),
]


def timed_search(client, index, body, iterations):
    # size:20 forces a real query+fetch each call (not just a cached count), and
    # request_cache=false stops the shard request cache from returning a memoized
    # answer — so we measure the query phase every iteration, where the join tax lives.
    body = {**body, "size": 20, "track_total_hits": True}
    tooks, total = [], None
    for _ in range(iterations):
        r = client.search(index=index, body=body, request_timeout=120, params={"request_cache": "false"})
        tooks.append(r["took"])
        total = r["hits"]["total"]["value"]
    return total, tooks


def pct(xs, p):
    return round(statistics.quantiles(xs, n=100)[p - 1], 1) if len(xs) > 1 else round(xs[0], 1)


def mean(xs):
    return round(statistics.fmean(xs), 1)


def index_size(client, name):
    s = client.cat.indices(index=name, format="json", bytes="b", h="docs.count,store.size")[0]
    return int(s["docs.count"]), int(s["store.size"])


def fielddata_bytes(client):
    st = client.nodes.stats(metric="indices", index_metric="fielddata")
    return sum(n["indices"]["fielddata"]["memory_size_in_bytes"]
               for n in st["nodes"].values())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--iterations", type=int, default=30)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--city", default="Las Vegas")
    args = ap.parse_args()
    client = get_client()

    fd_before = fielddata_bytes(client)
    results = []
    print(f"{'stage':30}{'hits':>12}{'flat mean':>11}{'flat p95':>10}"
          f"{'join mean':>11}{'join p95':>10}{'x(mean)':>9}")
    for stage, label in STAGES:
        for _ in range(args.warmup):
            client.search(index=INDEX_FLAT, body={**flat_query(stage, args.city), "size": 20})
            client.search(index=INDEX_JOIN, body={**join_query(stage, args.city), "size": 20})
        hf, tf = timed_search(client, INDEX_FLAT, flat_query(stage, args.city), args.iterations)
        hj, tj = timed_search(client, INDEX_JOIN, join_query(stage, args.city), args.iterations)
        assert hf == hj, f"HIT MISMATCH at '{label}': flat={hf:,} join={hj:,} (models not equivalent)"
        fm, fp95, jm, jp95 = mean(tf), pct(tf, 95), mean(tj), pct(tj, 95)
        ratio = round(jm / fm, 1) if fm else float("inf")
        print(f"{label:30}{hf:>12,}{fm:>11}{fp95:>10}{jm:>11}{jp95:>10}{ratio:>8}x")
        results.append({"stage": stage, "label": label, "hits": hf,
                        "flat_mean": fm, "flat_p95": fp95,
                        "join_mean": jm, "join_p95": jp95, "ratio": ratio})

    fd_after = fielddata_bytes(client)
    dc_f, sz_f = index_size(client, INDEX_FLAT)
    dc_j, sz_j = index_size(client, INDEX_JOIN)
    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "iterations": args.iterations, "city": args.city,
        "flat_docs": dc_f, "join_docs": dc_j,
        "flat_store_bytes": sz_f, "join_store_bytes": sz_j,
        "fielddata_before_bytes": fd_before, "fielddata_after_bytes": fd_after,
        "fielddata_delta_bytes": fd_after - fd_before,
    }
    OUT.write_text(json.dumps({"meta": meta, "stages": results}, indent=2))
    print("\n-- storage & memory --")
    print(f"  flat store : {sz_f/1e6:,.0f} MB  ({dc_f:,} docs)")
    print(f"  join store : {sz_j/1e6:,.0f} MB  ({dc_j:,} docs, incl. parents)")
    print(f"  fielddata heap grew {(fd_after-fd_before)/1e6:,.1f} MB running join queries "
          f"(global ordinals for the join field)")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
