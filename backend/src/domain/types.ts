/**
 * Shared domain types: roles, the trusted auth context, agreements, and the
 * role-specific protected response DTOs.
 */

export type Role = "customer_user" | "dealership_user" | "corporate_admin";

/**
 * The trusted identity for a request. Derived ONLY from a verified dev token —
 * never from client-supplied query/body parameters.
 */
export interface AuthContext {
  userId: string;
  role: Role;
  customerId: string | null;
  dealershipId: string | null;
}

/** A synthetic user as stored in data/users.json. */
export interface UserRecord {
  user_id: string;
  email: string;
  role: Role;
  customer_id: string | null;
  dealership_id: string | null;
  status: "active" | "inactive";
}

/** An active agreement relevant to pricing (subset of the indexed document). */
export interface AgreementRecord {
  dealership_id: string;
  vehicle_class: string | null;
  discount_percent: number;
  agreement_status: string;
  valid_from: string;
  valid_to: string;
}

/** A raw inventory candidate returned from OpenSearch (already _source-limited). */
export interface InventoryCandidate {
  inventory_id: string;
  dealership_id: string;
  dealership_name: string;
  dealership_city: string;
  make: string;
  model: string;
  vehicle_class: string;
  description: string;
  seats: number;
  fuel_type: string;
  quantity_available: number;
  base_daily_rate: number;
  status: string;
  score: number | null;
}

export type PricingSource = "customer_agreement" | "base_rate";

/**
 * Protected result for a customer_user. Note the deliberate absence of
 * customer_id, agreement_id, and any raw agreement / OpenSearch metadata.
 */
export interface CustomerResultDTO {
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
  pricing_source: PricingSource;
  agreement_applied: boolean;
}

/** Protected result for dealership_user / corporate_admin — base pricing only. */
export interface BaseResultDTO {
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

export type SortOption = "relevance" | "base_price_asc" | "personalized_price_asc";

export interface SearchParams {
  query?: string;
  vehicle_class?: string;
  city?: string;
  sort: SortOption;
}

/** Public shape of the authenticated identity returned to the UI (no secrets). */
export interface SessionProfile {
  user_id: string;
  role: Role;
  tenant_type: "customer" | "dealership" | "corporate";
  tenant_id: string | null;
  tenant_label: string;
}
