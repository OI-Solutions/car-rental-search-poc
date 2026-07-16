/**
 * Singleton OpenSearch client built from configuration.
 *
 * The frontend never receives these credentials — only this backend talks to
 * OpenSearch. TLS verification is disabled for the Phase 1 self-signed demo cert
 * (local dev only).
 */
import { Client } from "@opensearch-project/opensearch";
import { config } from "../config.js";

let client: Client | null = null;

export function getOpenSearchClient(): Client {
  if (!client) {
    client = new Client({
      node: config.opensearch.node,
      auth: {
        username: config.opensearch.username,
        password: config.opensearch.password,
      },
      ssl: {
        rejectUnauthorized: config.opensearch.verifyCerts,
      },
    });
  }
  return client;
}
