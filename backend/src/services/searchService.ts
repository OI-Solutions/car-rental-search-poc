/**
 * Inventory search service. Builds a *controlled* OpenSearch query from the
 * authenticated context plus validated domain inputs, and never accepts raw
 * Query DSL. Retrieval, filtering, and BM25 scoring happen in OpenSearch;
 * personalized pricing/sorting is applied later in the pricing layer.
 */
import type { Client } from "@opensearch-project/opensearch";
import { config } from "../config.js";
import type {
  AuthContext,
  InventoryCandidate,
  SearchParams,
} from "../domain/types.js";

// Bounded result size — the POC dataset is tiny (50 docs); this is large enough
// to fetch all candidates before application-side personalized-price sorting.
const MAX_RESULTS = 200;

// Only these fields ever leave OpenSearch; keeps _source explicit and minimal.
const SOURCE_FIELDS = [
  "inventory_id",
  "dealership_id",
  "dealership_name",
  "dealership_city",
  "make",
  "model",
  "vehicle_class",
  "description",
  "seats",
  "fuel_type",
  "quantity_available",
  "base_daily_rate",
  "status",
];

export function buildInventoryQuery(auth: AuthContext, params: SearchParams): Record<string, unknown> {
  // Availability rule: exclude only zero-quantity or explicitly "unavailable"
  // inventory. Both "available" and "limited" statuses still have rentable stock,
  // so they are included.
  const filter: Record<string, unknown>[] = [
    { range: { quantity_available: { gt: 0 } } },
  ];
  const mustNot: Record<string, unknown>[] = [{ term: { status: "unavailable" } }];

  if (params.vehicle_class) {
    filter.push({ term: { vehicle_class: params.vehicle_class } });
  }
  if (params.city) {
    filter.push({ term: { dealership_city: params.city } });
  }

  // Mandatory, non-overridable tenant scoping for dealership users. Derived from
  // the verified token — the client cannot set or remove this.
  if (auth.role === "dealership_user") {
    if (!auth.dealershipId) {
      // A dealership user with no dealership can see nothing.
      filter.push({ term: { dealership_id: "__none__" } });
    } else {
      filter.push({ term: { dealership_id: auth.dealershipId } });
    }
  }

  const must: Record<string, unknown>[] = [];
  if (params.query) {
    must.push({
      multi_match: {
        query: params.query,
        fields: ["make", "model", "vehicle_class", "description"],
      },
    });
  }

  return {
    bool: {
      ...(must.length ? { must } : {}),
      filter,
      must_not: mustNot,
    },
  };
}

function buildSort(params: SearchParams): Record<string, unknown>[] {
  // personalized_price_asc is resolved application-side after pricing, so we ask
  // OpenSearch for a deterministic order (cheapest base first) as a stable base.
  if (params.sort === "base_price_asc" || params.sort === "personalized_price_asc") {
    return [{ base_daily_rate: "asc" }, { inventory_id: "asc" }];
  }
  // relevance: _score first when there is a text query, else stable base order.
  if (params.query) {
    return [{ _score: "desc" }, { inventory_id: "asc" }];
  }
  return [{ inventory_id: "asc" }];
}

/** The complete request body sent to OpenSearch — single source of truth, also
 * surfaced by the dev "explain" inspector so it shows the real query. */
export function buildSearchBody(auth: AuthContext, params: SearchParams): Record<string, unknown> {
  return {
    size: MAX_RESULTS,
    _source: SOURCE_FIELDS,
    query: buildInventoryQuery(auth, params),
    sort: buildSort(params),
  };
}

export interface SearchDeps {
  client?: Client;
}

export async function searchInventory(
  auth: AuthContext,
  params: SearchParams,
  deps: SearchDeps = {},
): Promise<InventoryCandidate[]> {
  const { getOpenSearchClient } = await import("../opensearch/client.js");
  const client = deps.client ?? getOpenSearchClient();

  const body = buildSearchBody(auth, params);

  const res = await client.search({ index: config.indexes.inventory, body });
  const hits = (res.body.hits?.hits ?? []) as Array<{
    _source: Omit<InventoryCandidate, "score">;
    _score: number | null;
  }>;

  return hits.map((h) => ({ ...h._source, score: h._score ?? null }));
}
