/**
 * Pure personalized-pricing logic: agreement eligibility, precedence, and the
 * effective-rate formula. No I/O here so it is trivially unit-testable.
 *
 * Precedence (highest first):
 *   1. dealership + exact vehicle_class agreement
 *   2. dealership-wide agreement (vehicle_class = null)
 *   3. no agreement -> base rate
 *
 * Formula: effective = base_daily_rate * (1 - discount_percent / 100), 2dp.
 */
import type {
  AgreementRecord,
  PricingSource,
} from "../domain/types.js";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Eligible = active AND valid_from <= today <= valid_to (string yyyy-MM-dd compare). */
export function isEligible(a: AgreementRecord, now: Date): boolean {
  if (a.agreement_status !== "active") return false;
  const today = isoDate(now);
  return a.valid_from <= today && a.valid_to >= today;
}

export interface AgreementIndex {
  // dealership_id -> vehicle_class -> best discount percent
  byClass: Map<string, Map<string, number>>;
  // dealership_id -> best dealership-wide discount percent
  wide: Map<string, number>;
}

/** Build a fast lookup from a customer's agreements, keeping only eligible ones. */
export function buildAgreementIndex(
  agreements: AgreementRecord[],
  now: Date = new Date(),
): AgreementIndex {
  const byClass = new Map<string, Map<string, number>>();
  const wide = new Map<string, number>();

  for (const a of agreements) {
    if (!isEligible(a, now)) continue;
    if (a.vehicle_class === null) {
      const cur = wide.get(a.dealership_id);
      if (cur === undefined || a.discount_percent > cur) {
        wide.set(a.dealership_id, a.discount_percent);
      }
    } else {
      let classMap = byClass.get(a.dealership_id);
      if (!classMap) {
        classMap = new Map<string, number>();
        byClass.set(a.dealership_id, classMap);
      }
      const cur = classMap.get(a.vehicle_class);
      if (cur === undefined || a.discount_percent > cur) {
        classMap.set(a.vehicle_class, a.discount_percent);
      }
    }
  }

  return { byClass, wide };
}

export interface DiscountResolution {
  discountPercent: number;
  source: PricingSource;
}

/** Apply agreement precedence for one inventory item. */
export function resolveDiscount(
  index: AgreementIndex,
  dealershipId: string,
  vehicleClass: string,
): DiscountResolution {
  const classMatch = index.byClass.get(dealershipId)?.get(vehicleClass);
  if (classMatch !== undefined) {
    return { discountPercent: classMatch, source: "customer_agreement" };
  }
  const wideMatch = index.wide.get(dealershipId);
  if (wideMatch !== undefined) {
    return { discountPercent: wideMatch, source: "customer_agreement" };
  }
  return { discountPercent: 0, source: "base_rate" };
}

/** effective_daily_rate rounded to 2dp. */
export function effectiveRate(baseDailyRate: number, discountPercent: number): number {
  return round2(baseDailyRate * (1 - discountPercent / 100));
}
