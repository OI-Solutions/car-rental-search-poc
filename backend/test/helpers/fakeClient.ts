/**
 * A tiny in-memory stand-in for the OpenSearch client so orchestration tests are
 * deterministic and do not require a live cluster. It honors the term filters
 * that searchService builds (dealership_id, dealership_city, vehicle_class),
 * quantity>0, and status!=unavailable, over a fixed inventory fixture.
 */
import type { AgreementRecord, InventoryCandidate } from "../../src/domain/types.js";

export type InventorySource = Omit<InventoryCandidate, "score">;

interface Filter {
  term?: Record<string, string>;
  range?: Record<string, { gt?: number; lte?: string; gte?: number | string }>;
}

function termOf(filters: Filter[], field: string): string | undefined {
  for (const f of filters) {
    if (f.term && field in f.term) return f.term[field];
  }
  return undefined;
}

export function makeFakeClient(opts: {
  inventory: InventorySource[];
  agreementsByCustomer: Record<string, AgreementRecord[]>;
}) {
  const search = async ({ index, body }: { index: string; body: any }) => {
    if (index === "customer_agreements") {
      const filters = (body.query?.bool?.filter ?? []) as Filter[];
      const customerId = termOf(filters, "customer_id") ?? "";
      const agreements = opts.agreementsByCustomer[customerId] ?? [];
      return { body: { hits: { hits: agreements.map((a) => ({ _source: a })) } } };
    }

    // inventory
    const filters = (body.query?.bool?.filter ?? []) as Filter[];
    const mustNot = (body.query?.bool?.must_not ?? []) as Filter[];
    const dealershipId = termOf(filters, "dealership_id");
    const city = termOf(filters, "dealership_city");
    const vehicleClass = termOf(filters, "vehicle_class");
    const excludedStatus = termOf(mustNot, "status");

    const matched = opts.inventory.filter((inv) => {
      if (inv.quantity_available <= 0) return false;
      if (excludedStatus && inv.status === excludedStatus) return false;
      if (dealershipId && inv.dealership_id !== dealershipId) return false;
      if (city && inv.dealership_city !== city) return false;
      if (vehicleClass && inv.vehicle_class !== vehicleClass) return false;
      return true;
    });

    // Mimic the base_daily_rate asc sort the service asks for.
    matched.sort(
      (a, b) => a.base_daily_rate - b.base_daily_rate || a.inventory_id.localeCompare(b.inventory_id),
    );

    return { body: { hits: { hits: matched.map((inv) => ({ _source: inv, _score: null })) } } };
  };

  // Only `search` is used by the services under test.
  return { search } as unknown as import("@opensearch-project/opensearch").Client;
}

export function inv(overrides: Partial<InventorySource> & { inventory_id: string }): InventorySource {
  return {
    dealership_id: "DLR-CHI",
    dealership_name: "Chicago Central Fleet",
    dealership_city: "Chicago",
    make: "Ford",
    model: "Explorer",
    vehicle_class: "suv",
    description: "Three-row SUV.",
    seats: 7,
    fuel_type: "gasoline",
    quantity_available: 3,
    base_daily_rate: 92,
    status: "available",
    ...overrides,
  };
}
