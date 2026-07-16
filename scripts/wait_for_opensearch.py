#!/usr/bin/env python3
"""Block until the local OpenSearch cluster is reachable and healthy.

Polls the cluster health endpoint until it reports ``yellow`` or ``green`` (a
single-node dev cluster with unassigned replicas is normally ``yellow``), or
exits non-zero after a timeout. Run this before creating indexes or ingesting.
"""

from __future__ import annotations

import sys
import time

from opensearchpy.exceptions import OpenSearchException
from urllib3.exceptions import HTTPError

from common import get_client

TIMEOUT_SECONDS = 90
POLL_INTERVAL_SECONDS = 3
ACCEPTABLE_STATUSES = {"yellow", "green"}


def main() -> int:
    client = get_client()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    attempt = 0

    while time.monotonic() < deadline:
        attempt += 1
        try:
            health = client.cluster.health()
            status = health.get("status")
            if status in ACCEPTABLE_STATUSES:
                print(f"OpenSearch is up (cluster status: {status}).")
                return 0
            print(f"[attempt {attempt}] cluster status is '{status}', waiting...")
        except (OpenSearchException, HTTPError, ConnectionError) as exc:
            print(f"[attempt {attempt}] not ready yet: {exc.__class__.__name__}")

        time.sleep(POLL_INTERVAL_SECONDS)

    print(
        f"ERROR: OpenSearch did not become healthy within {TIMEOUT_SECONDS}s.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
