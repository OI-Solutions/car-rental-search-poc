/**
 * In-memory stand-in for the OpenSearch client, used when SEARCH_BACKEND=fixture.
 *
 * WHY THIS EXISTS: the demo box (1 vCPU / 1 GB) cannot run an OpenSearch cluster.
 * This lets the full API — auth, tenant scoping, agreement pricing, redaction —
 * run against the real `data/*.json` with no cluster, no Docker, no JVM.
 *
 * IMPORTANT: this is NOT a general Query DSL engine. It interprets exactly the
 * queries `searchService.buildInventoryQuery` and `getActiveAgreementsForCustomer`
 * produce (bool must/filter/must_not, term, range, multi_match) and nothing else.
 * If either service starts emitting a new clause shape, teach it here or the
 * clause will be silently ignored — see assertSupported below, which fails loudly
 * instead.
 *
 * Relevance is APPROXIMATED, not reproduced: real BM25 corpus statistics are
 * replaced with a field-weighted token match (see scoreMultiMatch). Over the
 * 50-doc POC corpus the ordering is demo-plausible, but it is not OpenSearch.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "@opensearch-project/opensearch";
import { DATA_DIR, config } from "../config.js";

/* -------------------------------------------------------------------------- */
/* Fixture loading — mirrors scripts/ingest_data.py:build_inventory_docs       */
/* -------------------------------------------------------------------------- */

interface RawInventory {
  inventory_id: string;
  dealership_id: string;
  vehicle_model_id: string;
  quantity_available: number;
  base_daily_rate: number;
  status: string;
  last_updated: string;
}
interface RawDealership {
  dealership_id: string;
  name: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
}
interface RawVehicleModel {
  vehicle_model_id: string;
  make: string;
  model: string;
  vehicle_class: string;
  seats: number;
  cargo_capacity: string;
  transmission: string;
  fuel_type: string;
  description: string;
}
interface RawAgreement {
  agreement_id: string;
  customer_id: string;
  dealership_id: string;
  vehicle_class: string | null;
  discount_percent: number;
  valid_from: string;
  valid_to: string;
  agreement_status: string;
}

type Doc = Record<string, unknown>;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(DATA_DIR, file), "utf8")) as T;
}

function byId<T extends Record<string, any>>(rows: T[], key: string): Map<string, T> {
  return new Map(rows.map((r) => [r[key] as string, r]));
}

/**
 * Denormalized inventory documents, joined exactly as the Python ingester builds
 * them. The join must stay in step with scripts/ingest_data.py:build_inventory_docs —
 * the API's SOURCE_FIELDS list is the contract both sides serve.
 */
function buildInventoryDocs(): Doc[] {
  const inventory = readJson<RawInventory[]>("inventory.json");
  const dealerships = byId(readJson<RawDealership[]>("dealerships.json"), "dealership_id");
  const models = byId(readJson<RawVehicleModel[]>("vehicle_models.json"), "vehicle_model_id");

  return inventory.map((inv) => {
    const dlr = dealerships.get(inv.dealership_id);
    const vm = models.get(inv.vehicle_model_id);
    if (!dlr) throw new Error(`fixture: inventory ${inv.inventory_id} references unknown dealership ${inv.dealership_id}`);
    if (!vm) throw new Error(`fixture: inventory ${inv.inventory_id} references unknown vehicle model ${inv.vehicle_model_id}`);

    return {
      inventory_id: inv.inventory_id,
      dealership_id: dlr.dealership_id,
      dealership_name: dlr.name,
      dealership_city: dlr.city,
      dealership_state: dlr.state,
      dealership_location: { lat: dlr.latitude, lon: dlr.longitude },
      vehicle_model_id: vm.vehicle_model_id,
      make: vm.make,
      model: vm.model,
      vehicle_class: vm.vehicle_class,
      description: vm.description,
      seats: vm.seats,
      fuel_type: vm.fuel_type,
      transmission: vm.transmission,
      cargo_capacity: vm.cargo_capacity,
      quantity_available: inv.quantity_available,
      base_daily_rate: inv.base_daily_rate,
      status: inv.status,
      last_updated: inv.last_updated,
    };
  });
}

/**
 * Agreement documents. agreementService only ever _source-projects the six
 * pricing fields, all of which exist on the raw records, so unlike inventory
 * this needs no join.
 */
function buildAgreementDocs(): Doc[] {
  return readJson<RawAgreement[]>("agreements.json").map((a) => ({ ...a }));
}

/* -------------------------------------------------------------------------- */
/* Minimal Query DSL interpretation                                            */
/* -------------------------------------------------------------------------- */

type Clause = Record<string, any>;

/** Fail loudly on a clause we do not implement, rather than silently over-returning. */
function assertSupported(clause: Clause, context: string): void {
  const kind = Object.keys(clause)[0];
  if (!["term", "range", "multi_match"].includes(kind)) {
    throw new Error(
      `fixtureClient: unsupported ${context} clause "${kind}". ` +
        `Teach fixtureClient this clause or the fixture demo will not match OpenSearch.`,
    );
  }
}

function matchesTerm(doc: Doc, clause: Clause): boolean {
  const [field, value] = Object.entries(clause.term)[0] as [string, unknown];
  return doc[field] === value;
}

/**
 * Range comparison. Dates here are ISO yyyy-MM-dd strings, which compare
 * correctly lexicographically, so the same operators serve numbers and dates —
 * exactly the two shapes these services emit (quantity_available, valid_from/to).
 */
function matchesRange(doc: Doc, clause: Clause): boolean {
  const [field, ops] = Object.entries(clause.range)[0] as [string, Record<string, any>];
  const v = doc[field] as number | string | undefined;
  if (v === undefined || v === null) return false;
  if (ops.gt !== undefined && !(v > ops.gt)) return false;
  if (ops.gte !== undefined && !(v >= ops.gte)) return false;
  if (ops.lt !== undefined && !(v < ops.lt)) return false;
  if (ops.lte !== undefined && !(v <= ops.lte)) return false;
  return true;
}

// Weights approximating how OpenSearch would favor identifier-ish fields over prose.
const FIELD_WEIGHTS: Record<string, number> = {
  make: 3,
  model: 3,
  vehicle_class: 2,
  description: 1,
};

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Approximates multi_match's default `best_fields` behavior: score each field
 * independently and take the best, rather than summing across fields.
 *
 * Returns null when nothing matched — the caller treats that as "excluded",
 * mirroring how a `must` clause drops non-matching documents.
 */
function scoreMultiMatch(doc: Doc, clause: Clause): number | null {
  const { query, fields } = clause.multi_match as { query: string; fields: string[] };
  const tokens = tokenize(query);
  if (tokens.length === 0) return null;

  let best = 0;
  for (const field of fields) {
    const raw = doc[field];
    if (typeof raw !== "string") continue;
    const haystack = tokenize(raw);
    const weight = FIELD_WEIGHTS[field] ?? 1;

    let hits = 0;
    for (const t of tokens) {
      // Exact token match scores full weight; a prefix/substring hit scores less,
      // standing in for OpenSearch's analyzer-level partial matching.
      if (haystack.includes(t)) hits += weight;
      else if (haystack.some((h) => h.includes(t))) hits += weight * 0.5;
    }
    if (hits > best) best = hits;
  }

  return best > 0 ? best : null;
}

interface Bool {
  must?: Clause[];
  filter?: Clause[];
  must_not?: Clause[];
}

/** Evaluate one doc against a bool query. Returns its score, or null if excluded. */
function evaluate(doc: Doc, bool: Bool): number | null {
  for (const clause of bool.filter ?? []) {
    assertSupported(clause, "filter");
    const ok = clause.term ? matchesTerm(doc, clause) : matchesRange(doc, clause);
    if (!ok) return null;
  }
  for (const clause of bool.must_not ?? []) {
    assertSupported(clause, "must_not");
    const hit = clause.term ? matchesTerm(doc, clause) : matchesRange(doc, clause);
    if (hit) return null;
  }

  // No `must` clauses means "match all that filtered" — OpenSearch would assign a
  // constant score; the services sort by explicit fields in that case, so 0 is fine.
  let score = 0;
  for (const clause of bool.must ?? []) {
    assertSupported(clause, "must");
    const s = scoreMultiMatch(doc, clause);
    if (s === null) return null;
    score += s;
  }
  return score;
}

/** Apply the sort spec, including the `_score` pseudo-field. */
function applySort(rows: { doc: Doc; score: number }[], sort: Clause[]): void {
  rows.sort((a, b) => {
    for (const spec of sort) {
      const [field, dir] = Object.entries(spec)[0] as [string, "asc" | "desc"];
      const av = field === "_score" ? a.score : (a.doc[field] as number | string);
      const bv = field === "_score" ? b.score : (b.doc[field] as number | string);
      if (av === bv) continue;
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : av < bv ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function project(doc: Doc, fields?: string[]): Doc {
  if (!fields) return { ...doc };
  const out: Doc = {};
  for (const f of fields) if (f in doc) out[f] = doc[f];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the fixture client. Fixtures load once at construction — the dataset is
 * ~30 KB, so the whole corpus sits in memory for the process lifetime.
 */
export function createFixtureClient(): Client {
  const inventory = buildInventoryDocs();
  const agreements = buildAgreementDocs();

  const search = async ({ index, body }: { index: string; body: any }) => {
    const corpus =
      index === config.indexes.inventory
        ? inventory
        : index === config.indexes.customerAgreements
          ? agreements
          : null;
    if (corpus === null) throw new Error(`fixtureClient: unknown index "${index}"`);

    const bool: Bool = body.query?.bool ?? {};
    const matched: { doc: Doc; score: number }[] = [];
    for (const doc of corpus) {
      const score = evaluate(doc, bool);
      if (score !== null) matched.push({ doc, score });
    }

    if (Array.isArray(body.sort)) applySort(matched, body.sort);

    const size = typeof body.size === "number" ? body.size : matched.length;
    const hits = matched.slice(0, size).map(({ doc, score }) => ({
      _source: project(doc, body._source),
      // A text query is the only thing that yields a meaningful score; otherwise
      // null, matching what OpenSearch returns for a pure filter query.
      _score: bool.must?.length ? score : null,
    }));

    return { body: { hits: { total: { value: matched.length }, hits } } };
  };

  // Only `search` is exercised by the services; anything else is a programming
  // error we want surfaced rather than stubbed.
  return { search } as unknown as Client;
}
