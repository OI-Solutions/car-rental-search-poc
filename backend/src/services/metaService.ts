/**
 * Static metadata for the UI dropdowns (vehicle classes + dealership cities),
 * derived from the synthetic data files. These are display helpers only and do
 * not affect authorization.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../config.js";

function load<T>(file: string): T[] {
  return JSON.parse(readFileSync(resolve(DATA_DIR, file), "utf-8")) as T[];
}

const vehicleClasses = Array.from(
  new Set(load<{ vehicle_class: string }>("vehicle_models.json").map((v) => v.vehicle_class)),
).sort();

const cities = Array.from(
  new Set(load<{ city: string }>("dealerships.json").map((d) => d.city)),
).sort();

export function getSearchMeta(): { vehicle_classes: string[]; cities: string[] } {
  return { vehicle_classes: vehicleClasses, cities };
}
