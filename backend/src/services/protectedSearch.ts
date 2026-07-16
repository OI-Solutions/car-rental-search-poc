/**
 * Orchestrates one protected search: controlled retrieval -> (customer only)
 * agreement retrieval + pricing -> role-specific redacted DTOs -> application-side
 * personalized-price sort when requested.
 *
 * Keeping this here (not in the route handler) isolates the business flow and
 * makes it directly testable.
 */
import type { Client } from "@opensearch-project/opensearch";
import type {
  AuthContext,
  BaseResultDTO,
  CustomerResultDTO,
  SearchParams,
} from "../domain/types.js";
import { searchInventory } from "./searchService.js";
import { getActiveAgreementsForCustomer } from "./agreementService.js";
import { buildAgreementIndex } from "./pricingService.js";
import { toBaseResult, toCustomerResult } from "../dto/mapResults.js";

export interface ProtectedSearchResponse {
  role: AuthContext["role"];
  pricing: "personalized" | "base";
  sort: SearchParams["sort"];
  count: number;
  results: CustomerResultDTO[] | BaseResultDTO[];
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
  const candidates = await searchInventory(auth, params, { client: services.client });

  // Only customer users get personalized pricing. Dealership + corporate users
  // receive base-price DTOs.
  if (auth.role !== "customer_user") {
    const results = candidates.map(toBaseResult);
    return {
      role: auth.role,
      pricing: "base",
      // personalized sort is meaningless without personalized pricing; the
      // OpenSearch order (base asc / relevance) already applies.
      sort: params.sort === "personalized_price_asc" ? "base_price_asc" : params.sort,
      count: results.length,
      results,
    };
  }

  // customer_user: one agreement query, build lookup, price every candidate.
  const agreements = auth.customerId
    ? await getActiveAgreementsForCustomer(auth.customerId, {
        client: services.client,
        now: services.now,
      })
    : [];
  const index = buildAgreementIndex(agreements, services.now ?? new Date());

  let results = candidates.map((c) => toCustomerResult(c, index));

  // Application-side rerank: OpenSearch cannot sort by a per-customer price.
  if (params.sort === "personalized_price_asc") {
    results = results
      .slice()
      .sort(
        (a, b) =>
          a.effective_daily_rate - b.effective_daily_rate ||
          a.inventory_id.localeCompare(b.inventory_id),
      );
  }

  return {
    role: auth.role,
    pricing: "personalized",
    sort: params.sort,
    count: results.length,
    results,
  };
}
