#!/usr/bin/env python3
"""Delete all POC indexes so the environment can be rebuilt from scratch.

This removes indexed data only; the Docker volume and source JSON files are left
untouched. Requires confirmation: pass ``--yes`` to skip the interactive prompt.
"""

from __future__ import annotations

import argparse

from common import ALL_INDEXES, get_client


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Delete without prompting for confirmation.",
    )
    args = parser.parse_args()

    if not args.yes:
        answer = input(
            f"Delete indexes {', '.join(ALL_INDEXES)}? This cannot be undone [y/N]: "
        )
        if answer.strip().lower() not in {"y", "yes"}:
            print("Aborted.")
            return 1

    client = get_client()
    for index in ALL_INDEXES:
        if client.indices.exists(index=index):
            client.indices.delete(index=index)
            print(f"deleted '{index}'")
        else:
            print(f"skip    '{index}' (does not exist)")

    print("Reset complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
