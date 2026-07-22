#!/usr/bin/env python3
"""Measure denormalized (bench_flat) vs parent/child (bench_join) across EVERY
cost dimension, not just read latency. Writes scripts/bench_dimensions.json,
consumed by the comparison report.

Dimensions measured here (read-latency ladder lives in bench_run.py):
  A. Aggregation cost   — "available units per vehicle_class": flat does it in ONE
                          terms agg; parent/child needs one has_parent query per
                          class (the attribute lives on the parent).
  B. Memory             — global-ordinals / fielddata heap the join field loads.
  C. Shard skew         — children are routed to their parent's shard, so shard
                          sizes are dictated by parent popularity, not balanced.
  D. Indexing throughput — time to load the SAME rows into a flat index vs a
                          join index (fresh temp indexes, deleted after).

Usage: python scripts/bench_dimensions.py [--index-sample 500000]
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from opensearchpy import helpers

from common import MAPPINGS_DIR, get_client, load_json
from bench_generate_ingest import build_models_and_metros, gen_actions, DEFAULT_CSV

FLAT, JOIN = "bench_flat", "bench_join"
CLASSES = ["car", "suv", "minivan", "truck", "van"]
OUT = Path(__file__).resolve().parent / "bench_dimensions.json"


def took_of(client, index, body):
    return client.search(index=index, body={**body, "size": 0}, params={"request_cache": "false"})["took"]


def med_took(client, index, body, n=20, warm=5):
    for _ in range(warm):
        client.search(index=index, body={**body, "size": 0})
    return round(statistics.median(took_of(client, index, body) for _ in range(n)), 1)


# ---- A. Aggregation ------------------------------------------------------- #
def agg_cost(client):
    flat_body = {
        "query": {"bool": {"filter": [{"term": {"status": "available"}}]}},
        "aggs": {"by_class": {"terms": {"field": "vehicle_class", "size": 20},
                              "aggs": {"units": {"sum": {"field": "quantity_available"}}}}},
    }
    flat_ms = med_took(client, FLAT, flat_body)

    # Parent/child: vehicle_class lives on the parent, so the child agg can't group
    # by it. You issue one has_parent query per class and stitch the results.
    total, per_class = 0.0, {}
    for c in CLASSES:
        body = {"query": {"bool": {"filter": [
            {"term": {"status": "available"}},
            {"has_parent": {"parent_type": "vehicle_model", "query": {"term": {"vehicle_class": c}}}},
        ]}}, "aggs": {"units": {"sum": {"field": "quantity_available"}}}}
        ms = med_took(client, JOIN, body, n=10, warm=3)
        per_class[c] = ms
        total += ms
    return {"flat_ms": flat_ms, "flat_queries": 1,
            "join_ms": round(total, 1), "join_queries": len(CLASSES), "join_per_class": per_class}


# ---- B. Memory (global ordinals / fielddata) ------------------------------ #
def memory_cost(client):
    def fd():
        st = client.nodes.stats(metric="indices", index_metric="fielddata")
        return sum(n["indices"]["fielddata"]["memory_size_in_bytes"] for n in st["nodes"].values())
    client.indices.clear_cache(index=JOIN, fielddata=True)
    before = fd()
    # Force the join field's global ordinals to load.
    for _ in range(3):
        client.search(index=JOIN, body={"size": 0, "query": {"bool": {"filter": [
            {"has_parent": {"parent_type": "vehicle_model", "query": {"term": {"vehicle_class": "suv"}}}}]}}})
    after = fd()
    return {"flat_fielddata_bytes": 0, "join_fielddata_bytes": after,
            "join_fielddata_delta_bytes": after - before}


# ---- C. Shard skew -------------------------------------------------------- #
def shard_skew(client, index):
    rows = client.cat.shards(index=index, format="json", h="shard,prirep,docs")
    docs = sorted(int(r["docs"]) for r in rows if r["prirep"] == "p" and r["docs"])
    if not docs:
        return {}
    return {"shards": len(docs), "min_docs": docs[0], "max_docs": docs[-1],
            "skew_ratio": round(docs[-1] / max(1, docs[0]), 2)}


# ---- D. Indexing throughput ----------------------------------------------- #
def indexing_cost(client, sample):
    models, metros = build_models_and_metros(DEFAULT_CSV)
    ftmp, jtmp = "bench_flat_tmp", "bench_join_tmp"
    results = {}
    for name, mapping, only in ((ftmp, "bench_flat.json", FLAT), (jtmp, "bench_join.json", JOIN)):
        if client.indices.exists(index=name):
            client.indices.delete(index=name)
        body = load_json(MAPPINGS_DIR / mapping)
        client.indices.create(index=name, body=body)
        if only == JOIN:
            parents = [{"_index": name, "_id": m["vehicle_model_id"], "routing": m["vehicle_model_id"],
                        "_source": {k: v for k, v in m.items() if k != "mean_rate"} | {"rel": "vehicle_model"}}
                       for m in models]
            helpers.bulk(client, parents, chunk_size=1000, request_timeout=120)

        def stream():
            for a in gen_actions(models, metros, sample, 6):
                if a["_index"] == only:
                    yield {**a, "_index": name}
        t0 = time.time()
        for _ in helpers.parallel_bulk(client, stream(), thread_count=4, chunk_size=4000,
                                       queue_size=8, raise_on_error=False, request_timeout=180):
            pass
        client.indices.refresh(index=name)
        dt = time.time() - t0
        size = int(client.cat.indices(index=name, format="json", bytes="b", h="store.size")[0]["store.size"])
        results[only] = {"rows": sample, "seconds": round(dt, 1),
                         "docs_per_sec": round(sample / dt), "store_bytes": size}
        client.indices.delete(index=name)
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index-sample", type=int, default=500_000)
    args = ap.parse_args()
    client = get_client()

    print("A. aggregation cost ...");   agg = agg_cost(client)
    print("B. memory / global ordinals ..."); mem = memory_cost(client)
    print("C. shard skew ...");         skew = {"flat": shard_skew(client, FLAT), "join": shard_skew(client, JOIN)}
    print(f"D. indexing throughput ({args.index_sample:,} rows each) ..."); idx = indexing_cost(client, args.index_sample)

    out = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "aggregation": agg, "memory": mem, "shard_skew": skew, "indexing": idx}
    OUT.write_text(json.dumps(out, indent=2))

    print("\n== dimension results ==")
    print(f"  aggregation : flat {agg['flat_ms']}ms (1 query)  vs  join {agg['join_ms']}ms ({agg['join_queries']} queries)")
    print(f"  memory      : flat 0 MB  vs  join {mem['join_fielddata_bytes']/1e6:.2f} MB global ordinals")
    print(f"  shard skew  : flat {skew['flat']}  vs  join {skew['join']}")
    print(f"  indexing    : flat {idx[FLAT]['docs_per_sec']:,}/s  vs  join {idx[JOIN]['docs_per_sec']:,}/s "
          f"({idx[FLAT]['seconds']}s vs {idx[JOIN]['seconds']}s for {args.index_sample:,} rows)")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
