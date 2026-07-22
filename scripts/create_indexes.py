#!/usr/bin/env python3
"""Create the POC indexes from the explicit mappings in opensearch/mappings/.

Idempotent by default: an index that already exists is left untouched. Pass
``--force`` to delete and recreate every index (destroys their contents).
"""

from __future__ import annotations

import argparse
import os

from common import ALL_INDEXES, MAPPINGS_DIR, get_client, load_json

# OpenSearch Serverless manages sharding/replication itself and rejects an
# explicit "settings" block (e.g. number_of_shards/number_of_replicas) on index
# creation. The mapping files under opensearch/mappings/ are shared with the
# Phase 1 local Docker cluster, which does need those settings, so strip them
# here rather than fork the mapping files.
def _body_for_backend(body: dict) -> dict:
    if os.getenv("OPENSEARCH_AUTH_MODE", "basic").strip().lower() == "sigv4":
        return {k: v for k, v in body.items() if k != "settings"}
    return body


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Delete and recreate each index even if it already exists.",
    )
    args = parser.parse_args()

    client = get_client()

    for index in ALL_INDEXES:
        body = _body_for_backend(load_json(MAPPINGS_DIR / f"{index}.json"))
        exists = client.indices.exists(index=index)

        if exists and args.force:
            client.indices.delete(index=index)
            exists = False
            print(f"deleted existing index '{index}' (--force)")

        if exists:
            print(f"skip    '{index}' (already exists)")
            continue

        client.indices.create(index=index, body=body)
        print(f"created '{index}'")

    print("Index creation complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
