import { describe, expect, it } from "vitest";
import {
  buildAgreementIndex,
  effectiveRate,
  isEligible,
  resolveDiscount,
  round2,
} from "../src/services/pricingService.js";
import type { AgreementRecord } from "../src/domain/types.js";

const NOW = new Date("2026-07-14T12:00:00Z");

function agreement(overrides: Partial<AgreementRecord>): AgreementRecord {
  return {
    dealership_id: "DLR-CHI",
    vehicle_class: null,
    discount_percent: 10,
    agreement_status: "active",
    valid_from: "2026-01-01",
    valid_to: "2026-12-31",
    ...overrides,
  };
}

describe("pricingService", () => {
  it("rounds currency to two decimal places", () => {
    expect(round2(66.239999)).toBe(66.24);
    expect(effectiveRate(92, 28)).toBe(66.24);
    expect(effectiveRate(97, 28)).toBe(69.84);
  });

  it("(#6) prefers a vehicle-class-specific agreement over a dealership-wide one", () => {
    const idx = buildAgreementIndex(
      [
        agreement({ vehicle_class: null, discount_percent: 20 }),
        agreement({ vehicle_class: "suv", discount_percent: 5 }),
      ],
      NOW,
    );
    const suv = resolveDiscount(idx, "DLR-CHI", "suv");
    expect(suv).toEqual({ discountPercent: 5, source: "customer_agreement" });

    // A different class at the same dealership falls back to the wide agreement.
    const sedan = resolveDiscount(idx, "DLR-CHI", "compact_sedan");
    expect(sedan).toEqual({ discountPercent: 20, source: "customer_agreement" });
  });

  it("(#5) returns the base rate when no agreement applies", () => {
    const idx = buildAgreementIndex(
      [agreement({ dealership_id: "DLR-PLN", vehicle_class: null, discount_percent: 15 })],
      NOW,
    );
    const res = resolveDiscount(idx, "DLR-CHI", "suv");
    expect(res).toEqual({ discountPercent: 0, source: "base_rate" });
    expect(effectiveRate(84, res.discountPercent)).toBe(84);
  });

  it("(#7) ignores inactive and expired agreements", () => {
    expect(isEligible(agreement({ agreement_status: "inactive" }), NOW)).toBe(false);
    expect(isEligible(agreement({ valid_to: "2026-06-30" }), NOW)).toBe(false); // expired
    expect(isEligible(agreement({ valid_from: "2026-08-01" }), NOW)).toBe(false); // not started
    expect(isEligible(agreement({}), NOW)).toBe(true);

    // Index built from only ineligible agreements yields no discount.
    const idx = buildAgreementIndex(
      [
        agreement({ agreement_status: "inactive", discount_percent: 30 }),
        agreement({ vehicle_class: "suv", valid_to: "2026-06-30", discount_percent: 40 }),
      ],
      NOW,
    );
    expect(resolveDiscount(idx, "DLR-CHI", "suv")).toEqual({
      discountPercent: 0,
      source: "base_rate",
    });
  });
});
