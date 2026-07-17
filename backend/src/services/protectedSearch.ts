/**
 * Orchestrates one protected search: controlled retrieval -> (customer only)
 * agreement retrieval + pricing -> role-specific redacted DTOs -> application-side
 * personalized-price sort when requested.
 *
 * Keeping this here (not in the route handler) isolates the business flow and
 * makes it directly testable.
 */
import type { Client } from "@opensearch-project/opensearch";
import { config } from "../config.js";
import type {
  AuthContext,
  BaseResultDTO,
  CustomerResultDTO,
  ExplainPayload,
  InventoryCandidate,
  SearchParams,
} from "../domain/types.js";
import { buildSearchBody, searchInventory } from "./searchService.js";
import { buildAgreementBody, getActiveAgreementsForCustomer } from "./agreementService.js";
import { buildAgreementIndex, type AgreementIndex } from "./pricingService.js";
import { toBaseResult, toCustomerResult } from "../dto/mapResults.js";

export interface ProtectedSearchResponse {
  role: AuthContext["role"];
  pricing: "personalized" | "base";
  sort: SearchParams["sort"];
  count: number;
  results: CustomerResultDTO[] | BaseResultDTO[];
  explain?: ExplainPayload;
}

export interface SearchServices {
  client?: Client;
  now?: Date;
}

export async function runProtectedSearch(
  auth: AuthContext,
  params: SearchParams,
  services: SearchServices = {},
): Promise<ProtectedSearchResponse> {
  const now = services.now ?? new Date();
  const candidates = await searchInventory(auth, params, { client: services.client });

  let results: CustomerResultDTO[] | BaseResultDTO[];
  let pricing: "personalized" | "base";
  let sort: SearchParams["sort"];
  let agreementIndex: AgreementIndex | null = null;

  if (auth.role !== "customer_user") {
    // Dealership + corporate users receive base-price DTOs (no pricing).
    results = candidates.map(toBaseResult);
    pricing = "base";
    // personalized sort is meaningless without personalized pricing.
    sort = params.sort === "personalized_price_asc" ? "base_price_asc" : params.sort;
  } else {
    // customer_user: one agreement query, build lookup, price every candidate.
    const agreements = auth.customerId
      ? await getActiveAgreementsForCustomer(auth.customerId, { client: services.client, now })
      : [];
    agreementIndex = buildAgreementIndex(agreements, now);

    let priced = candidates.map((c) => toCustomerResult(c, agreementIndex!));
    // Application-side rerank: OpenSearch cannot sort by a per-customer price.
    if (params.sort === "personalized_price_asc") {
      priced = priced
        .slice()
        .sort(
          (a, b) =>
            a.effective_daily_rate - b.effective_daily_rate ||
            a.inventory_id.localeCompare(b.inventory_id),
        );
    }
    results = priced;
    pricing = "personalized";
    sort = params.sort;
  }

  const response: ProtectedSearchResponse = {
    role: auth.role,
    pricing,
    sort,
    count: results.length,
    results,
  };

  if (params.explain) {
    response.explain = buildExplain(auth, params, candidates, results, now);
  }
  return response;
}

/** Assemble the dev-only inspector payload from the real query builders + data.
 * The sample is the top *displayed* result so the pricing math matches row #1. */
function buildExplain(
  auth: AuthContext,
  params: SearchParams,
  candidates: InventoryCandidate[],
  results: CustomerResultDTO[] | BaseResultDTO[],
  now: Date,
): ExplainPayload {
  // Show the safe request without the diagnostic flag itself.
  const { explain: _explain, ...validatedRequest } = params;

  const agreementsQuery =
    auth.role === "customer_user" && auth.customerId
      ? {
          index: config.indexes.customerAgreements,
          body: buildAgreementBody(auth.customerId, now),
        }
      : null;

  let sample: ExplainPayload["sample"] = null;
  const top = results[0];
  if (top) {
    // The raw retrieval record behind the top row (pre-redaction).
    const raw = candidates.find((c) => c.inventory_id === top.inventory_id) ?? candidates[0];
    const redacted = top as unknown as Record<string, unknown>;
    const pricing =
      "effective_daily_rate" in top
        ? {
            base_daily_rate: top.base_daily_rate,
            discount_percent: top.discount_percent,
            pricing_source: top.pricing_source,
            effective_daily_rate: top.effective_daily_rate,
            agreement_applied: top.agreement_applied,
          }
        : null;
    sample = {
      rawCandidate: { ...raw },
      redactedResult: redacted,
      droppedFields: Object.keys(raw).filter((k) => !(k in redacted)),
      pricing,
    };
  }

  return {
    note:
      "Dev-only inspector. A production API would NOT expose its internal query, " +
      "raw fields, or derived identity to clients — shown here purely to teach the flow.",
    authContext: auth,
    validatedRequest,
    inventoryQuery: { index: config.indexes.inventory, body: buildSearchBody(auth, params) },
    agreementsQuery,
    sample,
  };
}
