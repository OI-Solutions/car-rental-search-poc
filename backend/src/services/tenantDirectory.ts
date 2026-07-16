/**
 * In-memory directory of tenants (customers + dealerships) loaded from the
 * synthetic data files. Used only for human-readable display labels — never for
 * authorization decisions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../config.js";

interface CustomerRow {
  customer_id: string;
  company_name: string;
  home_city: string;
}

interface DealershipRow {
  dealership_id: string;
  name: string;
  city: string;
}

function load<T>(file: string): T[] {
  return JSON.parse(readFileSync(resolve(DATA_DIR, file), "utf-8")) as T[];
}

const customersById = new Map<string, CustomerRow>(
  load<CustomerRow>("customers.json").map((c) => [c.customer_id, c]),
);
const dealershipsById = new Map<string, DealershipRow>(
  load<DealershipRow>("dealerships.json").map((d) => [d.dealership_id, d]),
);

export function customerLabel(customerId: string | null): string {
  if (!customerId) return "Unknown customer";
  const c = customersById.get(customerId);
  return c ? `${c.company_name} (${c.home_city})` : customerId;
}

export function dealershipLabel(dealershipId: string | null): string {
  if (!dealershipId) return "Unknown dealership";
  const d = dealershipsById.get(dealershipId);
  return d ? `${d.name} (${d.city})` : dealershipId;
}
