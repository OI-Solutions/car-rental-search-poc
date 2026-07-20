/**
 * Singleton retrieval client built from configuration.
 *
 * The frontend never receives these credentials — only this backend talks to
 * OpenSearch. TLS verification is disabled for the Phase 1 self-signed demo cert
 * (local dev, basic-auth mode only — sigv4 targets real AWS endpoints with real
 * certs).
 *
 * When SEARCH_BACKEND=fixture this hands back an in-memory stand-in instead (see
 * fixtureClient.ts). Resolving it here means every caller — which already takes
 * an injectable `client` — gets the fixture with no service-layer changes.
 */
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
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

    if (config.opensearch.authMode === "sigv4") {
      // Required by OpenSearch Serverless (and IAM-auth OpenSearch Service
      // domains) — the security-plugin basic-auth model below does not apply.
      // Credentials come from the standard AWS SDK provider chain (env vars,
      // shared config file, or an instance/task role).
      client = new Client({
        ...AwsSigv4Signer({
          region: config.opensearch.region,
          service: config.opensearch.service as "es" | "aoss",
          getCredentials: () => defaultProvider()(),
        }),
        node: config.opensearch.node,
      });
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
