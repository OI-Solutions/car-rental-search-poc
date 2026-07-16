/**
 * FRONTEND-ONLY MOCK for the future "Procurement Search" concept.
 *
 * None of this calls a backend. It produces a static-but-plausible sourcing plan
 * so we can illustrate how demand would be *allocated* across locations. The
 * allocation here is a simple deterministic fill (sort + greedy) — deliberately
 * NOT a real optimizer, which would live in a future allocation service.
 *
 * Region coverage and rates are illustrative. Not every region is backed by
 * current OpenSearch data — "Central Illinois" is intentionally uncovered.
 */

export const VEHICLE_CLASSES = [
  "compact_sedan",
  "midsize_sedan",
  "suv",
  "pickup_truck",
  "cargo_van",
] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export type Objective =
  | "lowest_total_cost"
  | "highest_fulfillment"
  | "fewest_dealerships"
  | "balanced";

export const OBJECTIVES: { value: Objective; label: string }[] = [
  { value: "lowest_total_cost", label: "Lowest total cost" },
  { value: "highest_fulfillment", label: "Highest fulfillment" },
  { value: "fewest_dealerships", label: "Fewest dealerships" },
  { value: "balanced", label: "Balanced" },
];

export interface Region {
  id: string;
  label: string;
}

export const REGIONS: Region[] = [
  { id: "chicago_metro", label: "Chicago Metro" },
  { id: "north_nw", label: "North / Northwest Suburbs" },
  { id: "west", label: "West Suburbs" },
  { id: "southwest", label: "Southwest Suburbs" },
  { id: "central_il", label: "Central Illinois" },
];

interface MockDealer {
  id: string;
  name: string;
  regionId: string;
  contracted: boolean;
  discountPercent: number; // illustrative negotiated rate
  capacity: number; // mock available units for the chosen class
  baseRate: Record<VehicleClass, number>; // representative rates from the dataset
}

// Representative base daily rates derived from the Illinois dealership inventory.
const DEALERS: MockDealer[] = [
  {
    id: "DLR-CHI",
    name: "Chicago Central Fleet",
    regionId: "chicago_metro",
    contracted: true,
    discountPercent: 28,
    capacity: 8,
    baseRate: { compact_sedan: 56, midsize_sedan: 69, suv: 95, pickup_truck: 107, cargo_van: 120 },
  },
  {
    id: "DLR-SCH",
    name: "Schaumburg Corporate Mobility",
    regionId: "north_nw",
    contracted: true,
    discountPercent: 24,
    capacity: 7,
    baseRate: { compact_sedan: 56, midsize_sedan: 70, suv: 97, pickup_truck: 108, cargo_van: 121 },
  },
  {
    id: "DLR-NAP",
    name: "Naperville Commercial Auto",
    regionId: "west",
    contracted: true,
    discountPercent: 12,
    capacity: 6,
    baseRate: { compact_sedan: 55, midsize_sedan: 69, suv: 92, pickup_truck: 105, cargo_van: 116 },
  },
  {
    id: "DLR-PLN",
    name: "Plainfield Business Rentals",
    regionId: "southwest",
    contracted: true,
    discountPercent: 8,
    capacity: 7,
    baseRate: { compact_sedan: 51, midsize_sedan: 65, suv: 90, pickup_truck: 101, cargo_van: 113 },
  },
  {
    id: "DLR-JOL",
    name: "Joliet Jobsite Vehicles",
    regionId: "southwest",
    contracted: false, // spot / non-contracted — excluded when "contracted only" is on
    discountPercent: 15,
    capacity: 5,
    baseRate: { compact_sedan: 49, midsize_sedan: 62, suv: 85, pickup_truck: 98, cargo_van: 111 },
  },
];

const regionLabel = (id: string) => REGIONS.find((r) => r.id === id)?.label ?? id;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ProcurementForm {
  vehicleClass: VehicleClass;
  totalQuantity: number;
  regions: string[];
  maxDailyRate: number | null;
  objective: Objective;
  allowSplit: boolean;
  contractedOnly: boolean;
}

export type FulfillmentStatus = "Fulfilled" | "Partial" | "Planned" | "Unmet";

export interface AllocationRow {
  region: string;
  dealership: string;
  vehicleClass: VehicleClass;
  quantity: number;
  baseDailyRate: number;
  personalizedDailyRate: number;
  estimatedSubtotal: number;
  status: FulfillmentStatus;
}

export interface AllocationSummary {
  totalRequested: number;
  totalFulfilled: number;
  dealershipsUsed: number;
  estimatedTotalDailyCost: number;
  averagePersonalizedRate: number;
  unmetDemand: number;
}

export interface AllocationPlan {
  rows: AllocationRow[];
  summary: AllocationSummary;
  notes: string[];
}

interface Candidate {
  dealer: MockDealer;
  personalized: number;
}

/**
 * Build a deterministic mock sourcing plan. This is presentation logic, not an
 * optimizer: candidates are filtered, ordered by the chosen objective, then
 * filled greedily.
 */
export function buildMockAllocation(form: ProcurementForm): AllocationPlan {
  const notes: string[] = [];
  const vc = form.vehicleClass;

  // Regions the user picked that have no current dealership coverage.
  const selectedRegionsWithCoverage = new Set(
    DEALERS.map((d) => d.regionId).filter((r) => form.regions.includes(r)),
  );
  for (const rid of form.regions) {
    if (!selectedRegionsWithCoverage.has(rid)) {
      notes.push(`${regionLabel(rid)} has no contracted coverage in the current network (planned).`);
    }
  }

  // Candidate dealers from selected regions, after contracted-only and max-rate filters.
  let candidates: Candidate[] = DEALERS.filter((d) => form.regions.includes(d.regionId))
    .filter((d) => (form.contractedOnly ? d.contracted : true))
    .map((d) => ({
      dealer: d,
      personalized: round2(d.baseRate[vc] * (1 - d.discountPercent / 100)),
    }))
    .filter((c) => (form.maxDailyRate == null ? true : c.personalized <= form.maxDailyRate));

  // Order by optimization objective (mock heuristics).
  candidates = candidates.slice().sort((a, b) => {
    switch (form.objective) {
      case "lowest_total_cost":
      case "balanced":
        return a.personalized - b.personalized;
      case "highest_fulfillment":
      case "fewest_dealerships":
        return b.dealer.capacity - a.dealer.capacity;
    }
  });

  // Greedy fill.
  const rows: AllocationRow[] = [];
  let remaining = form.totalQuantity;

  if (!form.allowSplit) {
    // Single-source: use only the single best candidate.
    candidates = candidates.slice(0, 1);
    if (candidates.length) {
      notes.push("Split fulfillment is off — sourcing from a single dealership only.");
    }
  }

  const perDealerCap =
    form.objective === "balanced" && candidates.length
      ? Math.ceil(form.totalQuantity / candidates.length)
      : Infinity;

  for (const c of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(c.dealer.capacity, perDealerCap, remaining);
    if (take <= 0) continue;
    rows.push({
      region: regionLabel(c.dealer.regionId),
      dealership: c.dealer.name,
      vehicleClass: vc,
      quantity: take,
      baseDailyRate: c.dealer.baseRate[vc],
      personalizedDailyRate: c.personalized,
      estimatedSubtotal: round2(take * c.personalized),
      status: "Fulfilled",
    });
    remaining -= take;
  }

  const totalFulfilled = form.totalQuantity - Math.max(0, remaining);
  const estimatedTotalDailyCost = round2(
    rows.reduce((sum, r) => sum + r.estimatedSubtotal, 0),
  );

  // Represent leftover demand as an explicit unmet row so the plan is honest.
  if (remaining > 0) {
    rows.push({
      region: "—",
      dealership: "Unmet demand",
      vehicleClass: vc,
      quantity: remaining,
      baseDailyRate: 0,
      personalizedDailyRate: 0,
      estimatedSubtotal: 0,
      status: "Unmet",
    });
  }

  const summary: AllocationSummary = {
    totalRequested: form.totalQuantity,
    totalFulfilled,
    dealershipsUsed: rows.filter((r) => r.status === "Fulfilled").length,
    estimatedTotalDailyCost,
    averagePersonalizedRate:
      totalFulfilled > 0 ? round2(estimatedTotalDailyCost / totalFulfilled) : 0,
    unmetDemand: Math.max(0, remaining),
  };

  return { rows, summary, notes };
}
