/**
 * Input validation for the search endpoint. Only safe, domain-level fields are
 * accepted. Anything else (raw Query DSL, index names, _source, sort fields,
 * customer/dealership IDs) is rejected by `.strict()`.
 */
import { z } from "zod";
import type { SearchParams } from "../domain/types.js";

const trimmedString = (max: number) =>
  z.string().trim().min(1).max(max);

export const searchSchema = z
  .object({
    query: trimmedString(120).optional(),
    vehicle_class: trimmedString(60).optional(),
    city: trimmedString(60).optional(),
    sort: z
      .enum(["relevance", "base_price_asc", "personalized_price_asc"])
      .default("relevance"),
    // Dev-only: when true, the response includes an `explain` payload showing the
    // controlled query, raw→redacted diff, and pricing math. Not a business input.
    explain: z.boolean().optional(),
  })
  .strict();

export function parseSearchParams(input: unknown): SearchParams {
  return searchSchema.parse(input);
}
