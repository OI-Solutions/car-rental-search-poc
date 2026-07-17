/**
 * Singleton retrieval client built from configuration.
 *
 * The frontend never receives these credentials — only this backend talks to
 * OpenSearch. TLS verification is disabled for the Phase 1 self-signed demo cert
 * (local dev only).
 *
 * When SEARCH_BACKEND=fixture this hands back an in-memory stand-in instead (see
 * fixtureClient.ts). Resolving it here means every caller — which already takes
 * an injectable `client` — gets the fixture with no service-layer changes.
 */
import { Client } from "@opensearch-project/opensearch";
import { config } from "../config.js";
import { createFixtureClient } from "./fixtureClient.js";

let client: Client | null = null;

export function getOpenSearchClient(): Client {
  if (!client) {
    if (config.searchBackend === "fixture") {
      // Loud on purpose: nobody should ever wonder whether a running API is
      // serving real retrieval or fixtures.
      console.warn(
        "[crs] SEARCH_BACKEND=fixture — serving data/*.json from memory. " +
          "Relevance is approximated; this is NOT OpenSearch.",
      );
      client = createFixtureClient();
      return client;
    }

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
