#!/usr/bin/env python3
"""Generate deterministic synthetic data for the B2B car-rental search POC."""

from __future__ import annotations

import json
import random
from pathlib import Path

SEED = 42
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"


def write_json(name: str, rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / name).write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    random.seed(SEED)

    # This script intentionally regenerates the checked-in dataset by reading
    # the canonical JSON files and rewriting them in a stable format.
    # The seed is fixed so later extensions can add deterministic variation.
    required = [
        "dealerships.json",
        "vehicle_models.json",
        "inventory.json",
        "customers.json",
        "agreements.json",
        "users.json",
    ]

    for filename in required:
        path = DATA_DIR / filename
        if not path.exists():
            raise FileNotFoundError(
                f"Missing canonical source file: {path}. "
                "Restore the project dataset before regeneration."
            )
        rows = json.loads(path.read_text(encoding="utf-8"))
        write_json(filename, rows)

    print(f"Reformatted {len(required)} deterministic data files using seed {SEED}.")


if __name__ == "__main__":
    main()
