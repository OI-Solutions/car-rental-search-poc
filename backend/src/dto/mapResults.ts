/**
 * Response mapping / redaction. Converts raw inventory candidates into the
 * explicit protected DTOs. This is the ONLY place result shapes are produced, so
 * customer IDs, agreement IDs, raw agreements, and OpenSearch metadata can never
 * leak into a response.
 */
import type {
  AgreementIndex,
} from "../services/pricingService.js";
import { effectiveRate, resolveDiscount } from "../services/pricingService.js";
import type {
  BaseResultDTO,
  CustomerResultDTO,
  InventoryCandidate,
} from "../domain/types.js";

/** Customer-facing DTO with personalized pricing. */
export function toCustomerResult(
  c: InventoryCandidate,
  index: AgreementIndex,
): CustomerResultDTO {
  const { discountPercent, source } = resolveDiscount(
    index,
    c.dealership_id,
    c.vehicle_class,
  );
  const effective = effectiveRate(c.base_daily_rate, discountPercent);
  return {
    inventory_id: c.inventory_id,
    dealership_name: c.dealership_name,
    dealership_city: c.dealership_city,
    make: c.make,
    model: c.model,
    vehicle_class: c.vehicle_class,
    description: c.description,
    quantity_available: c.quantity_available,
    base_daily_rate: c.base_daily_rate,
    effective_daily_rate: effective,
    discount_percent: discountPercent,
    pricing_source: source,
    agreement_applied: source === "customer_agreement",
  };
}

/** Base-price DTO for dealership_user / corporate_admin (no pricing fields). */
export function toBaseResult(c: InventoryCandidate): BaseResultDTO {
  return {
    inventory_id: c.inventory_id,
    dealership_name: c.dealership_name,
    dealership_city: c.dealership_city,
    make: c.make,
    model: c.model,
    vehicle_class: c.vehicle_class,
    description: c.description,
    quantity_available: c.quantity_available,
    base_daily_rate: c.base_daily_rate,
  };
}
