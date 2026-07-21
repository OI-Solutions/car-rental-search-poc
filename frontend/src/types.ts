export type Role = "customer_user" | "dealership_user" | "corporate_admin";

export interface SessionProfile {
  user_id: string;
  role: Role;
  tenant_type: "customer" | "dealership" | "corporate";
  tenant_id: string | null;
  tenant_label: string;
}

export interface SearchMeta {
  vehicle_classes: string[];
  cities: string[];
}

export type SortOption = "base_price_asc" | "personalized_price_asc";

export interface SearchRequest {
  vehicle_class?: string;
  city?: string;
  sort: SortOption;
}

export interface CustomerResult {
  inventory_id: string;
  dealership_name: string;
  dealership_city: string;
  make: string;
  model: string;
  vehicle_class: string;
  description: string;
  quantity_available: number;
  base_daily_rate: number;
  effective_daily_rate: number;
  discount_percent: number;
  pricing_source: "customer_agreement" | "base_rate";
  agreement_applied: boolean;
}

export interface BaseResult {
  inventory_id: string;
  dealership_name: string;
  dealership_city: string;
  make: string;
  model: string;
  vehicle_class: string;
  description: string;
  quantity_available: number;
  base_daily_rate: number;
}

export interface SearchResponse {
  role: Role;
  pricing: "personalized" | "base";
  sort: SortOption;
  count: number;
  results: (CustomerResult | BaseResult)[];
  explain?: ExplainPayload;
}

/** Dev-only "under the hood" inspector payload (present only when explain=true). */
export interface ExplainPayload {
  note: string;
  authContext: {
    userId: string;
    role: Role;
    customerId: string | null;
    dealershipId: string | null;
  };
  validatedRequest: Record<string, unknown>;
  inventoryQuery: { index: string; body: unknown };
  agreementsQuery: { index: string; body: unknown } | null;
  sample: {
    rawCandidate: Record<string, unknown>;
    redactedResult: Record<string, unknown>;
    droppedFields: string[];
    pricing: {
      base_daily_rate: number;
      discount_percent: number;
      pricing_source: string;
      effective_daily_rate: number;
      agreement_applied: boolean;
    } | null;
  } | null;
}
