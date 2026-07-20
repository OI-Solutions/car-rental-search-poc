"""Shared configuration and OpenSearch client factory for the POC scripts.

Reads connection settings from the project `.env` file (or the process
environment) and builds a configured ``opensearch-py`` client. Keeping this in
one place lets the individual scripts stay small.

LOCAL DEVELOPMENT ONLY: TLS verification is intentionally disabled because the
security plugin uses a self-signed demo certificate.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from opensearchpy import OpenSearch, AWSV4SignerAuth, RequestsHttpConnection

# --- Paths -------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
MAPPINGS_DIR = PROJECT_ROOT / "opensearch" / "mappings"
QUERIES_DIR = PROJECT_ROOT / "opensearch" / "queries"

# Load .env from the project root if present (real env vars still win).
load_dotenv(PROJECT_ROOT / ".env")

# --- Index names -------------------------------------------------------------
INDEX_DEALERSHIPS = "dealerships"
INDEX_VEHICLE_MODELS = "vehicle_models"
INDEX_INVENTORY = "inventory"
INDEX_CUSTOMERS = "customers"
INDEX_CUSTOMER_AGREEMENTS = "customer_agreements"

# All indexes this POC manages, in dependency-friendly order.
ALL_INDEXES = [
    INDEX_DEALERSHIPS,
    INDEX_VEHICLE_MODELS,
    INDEX_INVENTORY,
    INDEX_CUSTOMERS,
    INDEX_CUSTOMER_AGREEMENTS,
]

# Maps each index to the source data file that feeds it.
SOURCE_FILES = {
    INDEX_DEALERSHIPS: DATA_DIR / "dealerships.json",
    INDEX_VEHICLE_MODELS: DATA_DIR / "vehicle_models.json",
    INDEX_INVENTORY: DATA_DIR / "inventory.json",
    INDEX_CUSTOMERS: DATA_DIR / "customers.json",
    INDEX_CUSTOMER_AGREEMENTS: DATA_DIR / "agreements.json",
}


def _env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def get_client() -> OpenSearch:
    """Build an OpenSearch client from environment configuration.

    OPENSEARCH_AUTH_MODE selects the auth model: "basic" (default, the Phase 1
    security-plugin username/password) or "sigv4" (AWS IAM request signing,
    required by OpenSearch Serverless). Credentials for sigv4 come from the
    standard boto3 provider chain (env vars, shared config/credentials file, or
    an instance/task role) — there is no separate app-specific credential shape.
    """
    host = os.getenv("OPENSEARCH_HOST", "localhost")
    port = int(os.getenv("OPENSEARCH_PORT", "9200"))
    scheme = os.getenv("OPENSEARCH_SCHEME", "https")
    verify_certs = _env_bool("OPENSEARCH_VERIFY_CERTS", default=False)
    auth_mode = os.getenv("OPENSEARCH_AUTH_MODE", "basic").strip().lower()

    if auth_mode == "sigv4":
        import boto3

        region = os.getenv("OPENSEARCH_REGION", "us-east-1")
        service = os.getenv("OPENSEARCH_SERVICE", "aoss")
        credentials = boto3.Session().get_credentials()
        if credentials is None:
            sys.exit(
                "ERROR: no AWS credentials found for OPENSEARCH_AUTH_MODE=sigv4. "
                "Configure them via env vars, `aws configure`, or an instance/task role."
            )
        auth = AWSV4SignerAuth(credentials, region, service)

        return OpenSearch(
            hosts=[{"host": host, "port": port}],
            http_auth=auth,
            use_ssl=(scheme == "https"),
            verify_certs=verify_certs,
            ssl_show_warn=verify_certs,
            connection_class=RequestsHttpConnection,
            # NextGen collections scale indexing/search OCUs from zero on the
            # first request after 10 minutes idle (AWS docs: ~10-30s to spin
            # up), which exceeds opensearch-py's default 10s timeout.
            timeout=60,
        )

    username = os.getenv("OPENSEARCH_USERNAME", "admin")
    password = os.getenv("OPENSEARCH_PASSWORD") or os.getenv(
        "OPENSEARCH_INITIAL_ADMIN_PASSWORD", ""
    )

    if not password:
        sys.exit(
            "ERROR: no OpenSearch password set. Copy .env.example to .env and set "
            "OPENSEARCH_PASSWORD / OPENSEARCH_INITIAL_ADMIN_PASSWORD."
        )

    return OpenSearch(
        hosts=[{"host": host, "port": port}],
        http_auth=(username, password),
        use_ssl=(scheme == "https"),
        verify_certs=verify_certs,
        ssl_show_warn=verify_certs,
    )


def load_json(path: Path):
    """Load and return the parsed JSON contents of ``path``."""
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_source(index: str):
    """Load the source records for a given index."""
    return load_json(SOURCE_FILES[index])
