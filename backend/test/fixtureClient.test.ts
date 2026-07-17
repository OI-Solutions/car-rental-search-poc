/**
 * Covers the fixture retrieval backend (SEARCH_BACKEND=fixture).
 *
 * These assert against the REAL data/*.json corpus, so they double as a guard on
 * the fixture data itself: if the denormalization join in scripts/ingest_data.py
 * and the one in fixtureClient.ts drift apart, or the demo dataset loses the
 * inactive-agreement case, these fail.
 */
import { describe, expect, it } from "vitest";
import { createFixtureClient } from "../src/opensearch/fixtureClient.js";
import { runProtectedSearch } from "../src/services/protectedSearch.js";
import { getActiveAgreementsForCustomer } from "../src/services/agreementService.js";
import type { AuthContext, CustomerResultDTO } from "../src/domain/types.js";

const NOW = new Date("2026-07-16T12:00:00Z");
const client = createFixtureClient();

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

describe("fixtureClient — denormalization", () => {
  it("joins dealership and vehicle-model fields onto inventory", async () => {
    const res = await runProtectedSearch(customerAuth("CUS-001"), { sort: "base_price_asc" }, { client, now: NOW });
    const first = res.results[0] as CustomerResultDTO;

    // These fields exist only via the join — inventory.json holds foreign keys.
    expect(first.dealership_name).toBeTruthy();
    expect(first.dealership_city).toBeTruthy();
    expect(first.make).toBeTruthy();
    expect(first.model).toBeTruthy();
    expect(first.vehicle_class).toBeTruthy();
  });
});

describe("fixtureClient — filters", () => {
  it("scopes a dealership user to its own inventory", async () => {
    const res = await runProtectedSearch(dealershipAuth("DLR-CHI"), { sort: "base_price_asc" }, { client, now: NOW });
    expect(res.count).toBeGreaterThan(0);
    expect(new Set(res.results.map((r) => r.dealership_name))).toEqual(new Set(["Chicago Central Fleet"]));
  });

  it("cannot be escaped by a city filter naming another dealership's city", async () => {
    const res = await runProtectedSearch(
      dealershipAuth("DLR-CHI"),
      { city: "Naperville", sort: "base_price_asc" },
      { client, now: NOW },
    );
    expect(res.count).toBe(0);
  });

  it("excludes unavailable and zero-quantity inventory", async () => {
    const res = await runProtectedSearch(customerAuth("CUS-001"), { sort: "base_price_asc" }, { client, now: NOW });
    for (const r of res.results) expect(r.quantity_available).toBeGreaterThan(0);
  });
});

describe("fixtureClient — text search", () => {
  it("matches a make and excludes everything else", async () => {
    const res = await runProtectedSearch(
      customerAuth("CUS-001"),
      { query: "toyota", sort: "relevance" },
      { client, now: NOW },
    );
    expect(res.count).toBeGreaterThan(0);
    expect(new Set(res.results.map((r) => r.make))).toEqual(new Set(["Toyota"]));
  });

  it("ranks class matches above incidental description matches", async () => {
    const res = await runProtectedSearch(
      customerAuth("CUS-001"),
      { query: "cargo van", sort: "relevance" },
      { client, now: NOW },
    );
    expect((res.results[0] as CustomerResultDTO).vehicle_class).toBe("cargo_van");
  });

  it("returns nothing for a query matching no document", async () => {
    const res = await runProtectedSearch(
      customerAuth("CUS-001"),
      { query: "zzzznotathing", sort: "relevance" },
      { client, now: NOW },
    );
    expect(res.count).toBe(0);
  });
});

describe("fixtureClient — agreements", () => {
  it("returns a customer's active, date-valid agreements", async () => {
    const agreements = await getActiveAgreementsForCustomer("CUS-001", { client, now: NOW });
    expect(agreements.length).toBeGreaterThan(0);
    for (const a of agreements) expect(a.agreement_status).toBe("active");
  });

  it("excludes inactive agreements (CUS-012's are all inactive)", async () => {
    const agreements = await getActiveAgreementsForCustomer("CUS-012", { client, now: NOW });
    expect(agreements).toEqual([]);
  });

  it("honors the valid_from/valid_to date range", async () => {
    const agreements = await getActiveAgreementsForCustomer("CUS-001", { client, now: new Date("2020-01-01") });
    expect(agreements).toEqual([]);
  });

  it("projects only pricing fields — raw agreement identifiers never leak", async () => {
    const [a] = await getActiveAgreementsForCustomer("CUS-001", { client, now: NOW });
    expect(a).not.toHaveProperty("agreement_id");
    expect(a).not.toHaveProperty("customer_id");
  });
});

describe("fixtureClient — guardrails", () => {
  it("throws on an unimplemented clause rather than silently over-returning", async () => {
    await expect(
      client.search({ index: "inventory", body: { query: { bool: { filter: [{ wildcard: { make: "toy*" } }] } } } }),
    ).rejects.toThrow(/unsupported filter clause "wildcard"/);
  });

  it("throws on an unknown index", async () => {
    await expect(client.search({ index: "nope", body: { query: { bool: {} } } })).rejects.toThrow(/unknown index/);
  });
});
