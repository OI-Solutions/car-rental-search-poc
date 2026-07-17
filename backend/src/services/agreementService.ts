/**
 * Agreement retrieval. Fetches ONLY the authenticated customer's active,
 * date-valid agreements, in a single query per search (never per result).
 *
 * Raw agreement documents never leave this layer — callers receive a minimal
 * AgreementRecord list used purely to compute pricing.
 */
import type { Client } from "@opensearch-project/opensearch";
import { config } from "../config.js";
import type { AgreementRecord } from "../domain/types.js";

export interface AgreementDeps {
  client?: Client;
  now?: Date;
}

/** ISO date (yyyy-MM-dd) for the "current date" agreement-validity comparison. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The exact agreements request body — single source of truth, also surfaced by
 * the dev "explain" inspector. Note the customer_id comes from the caller (the
 * verified token), never from the client request. */
export function buildAgreementBody(customerId: string, now: Date = new Date()): Record<string, unknown> {
  const today = isoDate(now);
  return {
    size: 100,
    _source: [
      "dealership_id",
      "vehicle_class",
      "discount_percent",
      "agreement_status",
      "valid_from",
      "valid_to",
    ],
    query: {
      bool: {
        filter: [
          { term: { customer_id: customerId } },
          { term: { agreement_status: "active" } },
          { range: { valid_from: { lte: today } } },
          { range: { valid_to: { gte: today } } },
        ],
      },
    },
  };
}

export async function getActiveAgreementsForCustomer(
  customerId: string,
  deps: AgreementDeps = {},
): Promise<AgreementRecord[]> {
  const { getOpenSearchClient } = await import("../opensearch/client.js");
  const client: Client = deps.client ?? getOpenSearchClient();

  const body = buildAgreementBody(customerId, deps.now ?? new Date());

  const res = await client.search({ index: config.indexes.customerAgreements, body });
  const hits = (res.body.hits?.hits ?? []) as Array<{ _source: AgreementRecord }>;
  return hits.map((h) => h._source);
}
