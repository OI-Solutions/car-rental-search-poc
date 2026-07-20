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

/**
 * "basic" is the Phase 1 security-plugin username/password model. "sigv4" is
 * AWS IAM request signing, required by Amazon OpenSearch Serverless (and also
 * usable against a managed OpenSearch Service domain configured for IAM auth).
 * AWS credentials themselves come from the standard SDK provider chain
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN env vars, or an
 * instance/task role) — there is no separate app-specific credential shape.
 */
export type OpenSearchAuthMode = "basic" | "sigv4";

export interface AppConfig {
  apiPort: number;
  corsOrigin: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  searchBackend: SearchBackend;
  opensearch: {
    node: string;
    authMode: OpenSearchAuthMode;
    username: string;
    password: string;
    verifyCerts: boolean;
    // sigv4 only:
    region: string;
    service: string;
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

function opensearchAuthMode(): OpenSearchAuthMode {
  const v = str("OPENSEARCH_AUTH_MODE", "basic").trim().toLowerCase();
  if (v !== "basic" && v !== "sigv4") {
    throw new Error(`Invalid OPENSEARCH_AUTH_MODE "${v}" — expected "basic" or "sigv4"`);
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
      authMode: opensearchAuthMode(),
      username: str("OPENSEARCH_USERNAME", "admin"),
      password:
        process.env.OPENSEARCH_PASSWORD ||
        process.env.OPENSEARCH_INITIAL_ADMIN_PASSWORD ||
        "",
      verifyCerts: bool("OPENSEARCH_VERIFY_CERTS", false),
      region: str("OPENSEARCH_REGION", "us-east-1"),
      // "aoss" for OpenSearch Serverless, "es" for a managed OpenSearch Service
      // domain configured for IAM auth.
      service: str("OPENSEARCH_SERVICE", "aoss"),
    },
    indexes: {
      inventory: "inventory",
      customerAgreements: "customer_agreements",
    },
  };
}

export const config = loadConfig();
