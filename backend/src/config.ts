/**
 * Typed application configuration, loaded from the project-root `.env`.
 *
 * The backend lives in `backend/` but shares the root `.env` used by the Phase 1
 * Python scripts (OpenSearch host/port/credentials), plus a few Phase 2 additions
 * (API port, JWT secret, CORS origin). LOCAL DEVELOPMENT ONLY.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/src -> project root
export const PROJECT_ROOT = resolve(__dirname, "..", "..");
export const DATA_DIR = resolve(PROJECT_ROOT, "data");

dotenv.config({ path: resolve(PROJECT_ROOT, ".env") });

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * Retrieval backend. "opensearch" talks to a real cluster; "fixture" serves the
 * `data/*.json` corpus from memory so the API can run without one (demo hosts too
 * small for a JVM). Everything above retrieval — auth, tenant scoping, agreement
 * pricing, redaction — is identical either way.
 */
export type SearchBackend = "opensearch" | "fixture";

export interface AppConfig {
  apiPort: number;
  corsOrigin: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  searchBackend: SearchBackend;
  opensearch: {
    node: string;
    username: string;
    password: string;
    verifyCerts: boolean;
  };
  indexes: {
    inventory: string;
    customerAgreements: string;
  };
}

function searchBackend(): SearchBackend {
  const v = str("SEARCH_BACKEND", "opensearch").trim().toLowerCase();
  if (v !== "opensearch" && v !== "fixture") {
    throw new Error(`Invalid SEARCH_BACKEND "${v}" — expected "opensearch" or "fixture"`);
  }
  return v;
}

export function loadConfig(): AppConfig {
  const scheme = str("OPENSEARCH_SCHEME", "https");
  const host = str("OPENSEARCH_HOST", "localhost");
  const port = str("OPENSEARCH_PORT", "9200");

  return {
    apiPort: Number(str("API_PORT", "4000")),
    corsOrigin: str("CORS_ORIGIN", "http://localhost:5173"),
    // Defaults to the real cluster: fixture mode must be opted into explicitly so
    // a missing env var can never silently serve fake retrieval in production.
    searchBackend: searchBackend(),
    // The dev secret has a fallback so tests/dev "just work", but it is clearly
    // labeled and expected to be overridden via .env.
    jwtSecret: str("JWT_DEV_SECRET", "dev-only-insecure-secret-change-me"),
    jwtTtlSeconds: Number(str("JWT_TTL_SECONDS", "3600")),
    opensearch: {
      node: `${scheme}://${host}:${port}`,
      username: str("OPENSEARCH_USERNAME", "admin"),
      password:
        process.env.OPENSEARCH_PASSWORD ||
        process.env.OPENSEARCH_INITIAL_ADMIN_PASSWORD ||
        "",
      verifyCerts: bool("OPENSEARCH_VERIFY_CERTS", false),
    },
    indexes: {
      inventory: "inventory",
      customerAgreements: "customer_agreements",
    },
  };
}

export const config = loadConfig();
