import { describe, expect, it } from "vitest";
import { buildInventoryQuery } from "../src/services/searchService.js";
import { runProtectedSearch } from "../src/services/protectedSearch.js";
import type { AgreementRecord, AuthContext, CustomerResultDTO } from "../src/domain/types.js";
import { inv, makeFakeClient } from "./helpers/fakeClient.js";

const NOW = new Date("2026-07-14T12:00:00Z");

const customerAuth = (customerId: string): AuthContext => ({
  userId: `u-${customerId}`,
  role: "customer_user",
  customerId,
  dealershipId: null,
});
const dealershipAuth = (dealershipId: string): AuthContext => ({
  userId: `u-${dealershipId}`,
  role: "dealership_user",
  customerId: null,
  dealershipId,
});
const corporateAuth = (): AuthContext => ({
  userId: "u-corp",
  role: "corporate_admin",
  customerId: null,
  dealershipId: null,
});

function wideAgreement(dealershipId: string, pct: number): AgreementRecord {
  return {
    dealership_id: dealershipId,
    vehicle_class: null,
    discount_percent: pct,
    agreement_status: "active",
    valid_from: "2026-01-01",
    valid_to: "2026-12-31",
  };
}

// A multi-dealership, multi-class inventory fixture.
const INVENTORY = [
  inv({ inventory_id: "INV-CHI-SUV-01", dealership_id: "DLR-CHI", dealership_city: "Chicago", vehicle_class: "suv", base_daily_rate: 92 }),
  inv({ inventory_id: "INV-CHI-SED-01", dealership_id: "DLR-CHI", dealership_city: "Chicago", vehicle_class: "compact_sedan", base_daily_rate: 55, make: "Toyota", model: "Corolla" }),
  inv({ inventory_id: "INV-JOL-SUV-01", dealership_id: "DLR-JOL", dealership_name: "Joliet Jobsite Vehicles", dealership_city: "Joliet", vehicle_class: "suv", base_daily_rate: 84 }),
  inv({ inventory_id: "INV-JOL-SUV-02", dealership_id: "DLR-JOL", dealership_name: "Joliet Jobsite Vehicles", dealership_city: "Joliet", vehicle_class: "suv", base_daily_rate: 86, status: "limited" }),
  inv({ inventory_id: "INV-JOL-ZERO", dealership_id: "DLR-JOL", dealership_city: "Joliet", vehicle_class: "suv", base_daily_rate: 50, quantity_available: 0 }),
];

describe("buildInventoryQuery (controlled query construction)", () => {
  it("(#9/#10) injects a mandatory dealership filter for dealership users", () => {
    const q = buildInventoryQuery(dealershipAuth("DLR-JOL"), { sort: "relevance" }) as any;
    const terms = q.bool.filter.filter((f: any) => f.term?.dealership_id);
    expect(terms).toContainEqual({ term: { dealership_id: "DLR-JOL" } });
  });

  it("does NOT add a dealership filter for customer users", () => {
    const q = buildInventoryQuery(customerAuth("CUS-001"), { sort: "relevance" }) as any;
    const terms = q.bool.filter.filter((f: any) => f.term?.dealership_id);
    expect(terms).toHaveLength(0);
  });

  it("always excludes zero-quantity and unavailable inventory", () => {
    const q = buildInventoryQuery(corporateAuth(), { sort: "relevance" }) as any;
    expect(q.bool.filter).toContainEqual({ range: { quantity_available: { gt: 0 } } });
    expect(q.bool.must_not).toContainEqual({ term: { status: "unavailable" } });
  });
});

describe("runProtectedSearch (orchestration)", () => {
  it("(#4/#5) two customers get different effective prices for the same inventory", async () => {
    const client = makeFakeClient({
      inventory: INVENTORY,
      agreementsByCustomer: {
        // CUS-001 has a Chicago-wide 28% deal; CUS-XX has none at Chicago.
        "CUS-001": [wideAgreement("DLR-CHI", 28)],
        "CUS-XX": [wideAgreement("DLR-PLN", 20)],
      },
    });

    const a = await runProtectedSearch(customerAuth("CUS-001"), { vehicle_class: "suv", sort: "base_price_asc" }, { client, now: NOW });
    const b = await runProtectedSearch(customerAuth("CUS-XX"), { vehicle_class: "suv", sort: "base_price_asc" }, { client, now: NOW });

    const chiA = (a.results as CustomerResultDTO[]).find((r) => r.inventory_id === "INV-CHI-SUV-01")!;
    const chiB = (b.results as CustomerResultDTO[]).find((r) => r.inventory_id === "INV-CHI-SUV-01")!;

    expect(chiA.effective_daily_rate).toBe(66.24); // 92 * 0.72
    expect(chiA.pricing_source).toBe("customer_agreement");
    expect(chiB.effective_daily_rate).toBe(92); // base rate — no applicable agreement (#5)
    expect(chiB.pricing_source).toBe("base_rate");
    expect(chiA.effective_daily_rate).not.toBe(chiB.effective_daily_rate);
  });

  it("(#8) a customer result never exposes raw agreement / tenant identifiers", async () => {
    const client = makeFakeClient({
      inventory: INVENTORY,
      agreementsByCustomer: { "CUS-001": [wideAgreement("DLR-CHI", 28)] },
    });
    const res = await runProtectedSearch(customerAuth("CUS-001"), { sort: "relevance" }, { client, now: NOW });
    const keys = Object.keys(res.results[0]);
    for (const forbidden of ["customer_id", "agreement_id", "dealership_id", "_id", "_source", "_score"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("(#9/#10) a dealership user sees only its own dealership's inventory", async () => {
    const client = makeFakeClient({ inventory: INVENTORY, agreementsByCustomer: {} });
    const res = await runProtectedSearch(dealershipAuth("DLR-JOL"), { sort: "relevance" }, { client, now: NOW });
    expect(res.pricing).toBe("base");
    const dealers = new Set(res.results.map((r) => r.dealership_name));
    expect([...dealers]).toEqual(["Joliet Jobsite Vehicles"]);
    // zero-quantity item is excluded; the "limited" one is included.
    const ids = res.results.map((r) => r.inventory_id);
    expect(ids).toContain("INV-JOL-SUV-02"); // limited but in-stock
    expect(ids).not.toContain("INV-JOL-ZERO");
    // Base DTO carries no personalized pricing fields.
    expect((res.results[0] as any).effective_daily_rate).toBeUndefined();
  });

  it("(#11) a corporate admin searches across all dealerships (base pricing)", async () => {
    const client = makeFakeClient({ inventory: INVENTORY, agreementsByCustomer: {} });
    const res = await runProtectedSearch(corporateAuth(), { sort: "relevance" }, { client, now: NOW });
    expect(res.pricing).toBe("base");
    const dealers = new Set(res.results.map((r) => r.dealership_name));
    expect(dealers.size).toBeGreaterThan(1);
  });

  it("(#12) personalized_price_asc sorts AFTER pricing is applied, not by base rate", async () => {
    // Joliet SUV base 84 with 0% vs Chicago SUV base 92 with 28% -> 66.24.
    // Base order: Joliet(84) < Chicago(92). Personalized order flips: Chicago(66.24) < Joliet(84).
    const client = makeFakeClient({
      inventory: INVENTORY,
      agreementsByCustomer: { "CUS-001": [wideAgreement("DLR-CHI", 28)] },
    });
    const res = await runProtectedSearch(customerAuth("CUS-001"), { vehicle_class: "suv", sort: "personalized_price_asc" }, { client, now: NOW });
    const order = (res.results as CustomerResultDTO[]).map((r) => r.inventory_id);

    // Effective rates must be non-decreasing.
    const rates = (res.results as CustomerResultDTO[]).map((r) => r.effective_daily_rate);
    expect(rates).toEqual([...rates].sort((x, y) => x - y));
    // Chicago (personalized 66.24) now ranks ahead of Joliet (84), inverting base order.
    expect(order.indexOf("INV-CHI-SUV-01")).toBeLessThan(order.indexOf("INV-JOL-SUV-01"));
  });
});
