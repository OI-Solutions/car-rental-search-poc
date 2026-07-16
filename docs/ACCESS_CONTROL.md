# Multi-Tenant Access Control — Design Note

This document is the conceptual heart of the POC. It explains **how the
application layer separates *authorization* from *retrieval*** in a multi-tenant
B2B system, and why that separation is the right architecture.

> **Thesis:** In this multi-tenant system the **application layer owns the primary
> authorization and business-policy decision** — identity, tenant scoping, pricing,
> and redaction happen *around* retrieval and are never delegated to the client.
> OpenSearch is the retrieval engine; its own security controls *may* enforce
> overlapping datastore restrictions as **defense in depth** (see the Production
> notes below). This project is a small, complete demonstration of that separation.

---

## At a glance: the protected search flow

The complete `customer_user` path, end to end — every step below runs in the
application except the two OpenSearch retrievals:

```mermaid
sequenceDiagram
    participant B as User / Browser
    participant App as Application (Express)
    participant Price as Pricing service
    participant OS as OpenSearch
    B->>App: POST /api/search (Bearer token + safe inputs)
    App->>App: verify token, derive role + tenant (AuthContext)
    App->>App: validate safe search inputs (allow-list)
    App->>OS: controlled inventory query (+ mandatory tenant filter)
    OS-->>App: inventory candidates (available, qty > 0)
    App->>OS: authenticated customer's active agreements (1 query)
    OS-->>App: agreements
    App->>Price: calculate effective rates (precedence + formula)
    Price-->>App: priced results
    App->>App: optionally rerank by personalized price
    App->>App: DTO mapper redacts internal fields
    App-->>B: authorized, personalized results
```

> Role differences: only `customer_user` triggers agreement retrieval and pricing;
> `dealership_user` and `corporate_admin` skip straight to base-price redaction (the
> dealership user additionally carries a mandatory dealership filter).

---

## 1. The tenancy model

Two things are easy to conflate but must be kept distinct: **who you are** (role)
and **which slice of data you belong to** (tenant).

| Concept | In this system |
| --- | --- |
| **Tenant** — an isolation boundary for data | a **customer** organization (`CUS-*`) or a **dealership** (`DLR-*`) |
| **Role** — what a user is allowed to do | `customer_user`, `dealership_user`, `corporate_admin` |
| **Cross-tenant principal** | `corporate_admin` — deliberately spans all tenants |

A single inventory corpus is shared by every tenant, but **what each tenant may
see and at what price differs**:

| Role | Tenant | Retrieval scope | Pricing scope |
| --- | --- | --- | --- |
| `customer_user` | one customer org | all dealerships' inventory | **only its own** negotiated agreements |
| `dealership_user` | one dealership | **only its own** dealership's inventory | base price only |
| `corporate_admin` | none (privileged) | all dealerships' inventory | base price only (Phase 2) |

The key multi-tenant challenges this raises:
- **Horizontal isolation** — a dealership user must never see another dealership's
  inventory; a customer must never see another customer's pricing.
- **Data-dependent authorization** — a customer's *price* depends on *its own*
  private agreements, which are commercial data other tenants must not read.
- **A shared backing store** — all of this sits in one OpenSearch cluster with one
  set of credentials.

---

## 2. Why the application owns primary authorization

OpenSearch is excellent at what a search engine should do: **retrieve, filter,
score (BM25), and aggregate**. Here it is used for exactly that, and the
**application owns the primary authorization and business-policy decision.**
OpenSearch security controls *may* enforce overlapping datastore restrictions as
defense in depth — the two are complementary, not either/or. The primary control
sits in the application for concrete reasons:

1. **The query is only as trustworthy as who built it.** If the browser could send
   Query DSL, "authorization" would mean trusting the client to filter its own
   results — which is no authorization at all. The **frontend never talks to
   OpenSearch** and never holds its credentials; the server constructs every query
   from a *verified* identity. (See [§4](#4-the-four-authorization-checkpoints).)
2. **Business rules aren't index security.** Agreement **precedence** (class-specific
   beats dealership-wide) and the **effective-price formula** are domain logic, not
   something document-/field-level security can express.
3. **One place to reason about and audit.** Concentrating authorization in a few
   named modules makes the rules reviewable and testable, instead of scattering
   them across index templates, roles, and query-time security.
4. **Single shared credential today.** The Phase 1 cluster uses one admin user.
   Per-tenant OpenSearch identities/DLS could be added later as *defense in depth*
   ([§7](#7-defense-in-depth-what-production-would-add)) — but they would sit
   **beneath** the application control, not replace it.

**Separation of responsibilities:**

| OpenSearch (retrieval) | Application (authorization + policy) |
| --- | --- |
| Match documents by controlled filters | Decide *who* is asking (verify token → identity) |
| BM25 relevance scoring | Decide *what* filters are mandatory (tenant scoping) |
| Aggregations | Reject untrusted inputs (raw DSL, authoritative IDs) |
| Return `_source` for whitelisted fields | Resolve per-tenant pricing from private agreements |
| — | Redact results into role-specific DTOs |
| — | Re-rank by personalized price (engine can't) |

> **Production note — defense in depth.** Add per-tenant OpenSearch **service
> identities** and **Document-/Field-Level Security (DLS/FLS)** so the datastore
> *also* enforces tenant isolation. These sit *beneath* the application control and
> guard against an application bug — they do not replace it.

---

## 3. The trust boundary

Everything the client sends is **untrusted input**. The only trusted assertion of
identity is the **signed token the server itself issued**.

```mermaid
flowchart LR
    subgraph U["UNTRUSTED — client-controlled"]
        T["Authorization: Bearer token"]
        S["body: query, vehicle_class, city, sort"]
        X["body: customer_id, dealership_id<br/>✗ ignored / rejected"]
    end
    subgraph V["TRUSTED — server-derived"]
        A["AuthContext<br/>role, customerId, dealershipId<br/>(user re-checked active)"]
    end
    T -- "verify signature" --> A
    S -. "validated inputs only" .-> A
    X -- "never trusted" --x A
```

- `AuthContext` is built **only** from verified token claims — never from query or
  body. A `customer_id` or `dealership_id` in the request body is rejected by
  strict input validation and is **never** read as authority.
- The token is re-validated on every request, and the user is re-checked for
  `active` status, so a token minted before deactivation stops working.

Defined in: `backend/src/domain/types.ts` (`AuthContext`),
`backend/src/auth/session.ts` (sign/verify), `backend/src/auth/middleware.ts`
(verify + active re-check).

---

## 4. The four authorization checkpoints

Every protected request passes through four independent controls. Each one stops a
distinct class of attack; they are layered so a mistake in one is not catastrophic.

```mermaid
flowchart LR
    R([Request]) --> C1{"1· Authenticated<br/>& active?"}
    C1 -- no --> D1[401 / 403]
    C1 -- yes --> C2{"2· Only safe<br/>domain inputs?"}
    C2 -- no --> D2[400]
    C2 -- yes --> C3["3· Server builds query<br/>+ mandatory tenant filter"]
    C3 --> C4["4· Own-tenant pricing<br/>+ DTO redaction"]
    C4 --> OK([Protected response])
```

### Checkpoint 1 — Authentication gate
**Where:** `backend/src/auth/middleware.ts` (`requireAuth`)
**Enforces:** a valid, unexpired, correctly-signed token belonging to an **active**
user. Missing/garbage token → `401`; deactivated user → `403`.
**Stops:** anonymous access; use of a revoked identity; token forgery (signature
check).

> **Production note — identity.** The mock dev-session JWT stands in for a real
> **OIDC/SAML identity provider**. In production the IdP *authenticates* the user;
> the application still *maps* that identity to internal **roles and tenants** and
> makes the authorization decision. Application-level authorization stays primary.

### Checkpoint 2 — Input validation (allow-list)
**Where:** `backend/src/validation/searchSchema.ts` (zod, `.strict()`)
**Enforces:** the request may contain **only** `query`, `vehicle_class`, `city`,
`sort` (an enum). Any other key — raw Query DSL, index names, `_source`,
`customer_id`, `dealership_id`, arbitrary sort fields — is rejected with `400`.
**Stops:** query-injection; identity override via parameters; exfiltration via
attacker-chosen fields/sorts.

### Checkpoint 3 — Controlled query + mandatory tenant filter
**Where:** `backend/src/services/searchService.ts` (`buildInventoryQuery`)
**Enforces:** the server builds the entire OpenSearch query. Base filters
(`status`, `quantity_available > 0`) always apply. For a `dealership_user`, a
**mandatory** `dealership_id` term filter is injected **from the token** and cannot
be removed or widened because no client input feeds it.
**Stops:** a dealership user reading another dealership's inventory; any attempt to
broaden retrieval scope.

### Checkpoint 4 — Response scoping & redaction
**Where:** `backend/src/services/protectedSearch.ts` (orchestration + pricing
scope), `backend/src/dto/mapResults.ts` (field whitelist)
**Enforces:** pricing is computed **only** from the authenticated customer's own
agreements (retrieved with the token's `customerId`, never a supplied one).
Results are mapped into explicit DTOs that **omit** `customer_id`, agreement IDs,
raw agreements, unrestricted `_source`, and OpenSearch metadata.
**Stops:** cross-customer pricing disclosure; leakage of private commercial data
(agreements) or internal fields into responses.

---

## 5. Per-role walkthrough

### `customer_user`
- **Retrieval:** unrestricted across dealerships **by design** — customers shop the
  whole network.
- **Pricing (the sensitive part):** the service calls
  `getActiveAgreementsForCustomer(auth.customerId)` — the customer id comes from the
  **token**, so a customer can only ever price against *its own* agreements
  (`backend/src/services/agreementService.ts`). Precedence and the effective-rate
  formula are applied in `backend/src/services/pricingService.ts`.
- **Redaction:** the customer DTO shows base + effective rate and a
  `pricing_source`, but **never** the agreement itself, its id, or any customer id.

### `dealership_user`
- **Retrieval:** constrained to its own dealership by the mandatory filter in
  Checkpoint 3. There is no request parameter that can change this.
- **Pricing:** none — dealership users see **base** prices via the base DTO.
- **Isolation:** it can never see another dealership's inventory or any customer's
  private pricing/agreements.

### `corporate_admin`
- **Retrieval:** cross-tenant (all dealerships).
- **Pricing:** base prices only in Phase 2 (no per-customer pricing surface).

---

## Worked example: a customer SUV search

Following one request through the layers. Identity: `USR-001-C` → customer
`CUS-001` (which has a 28% dealership-wide agreement at Chicago).

**1 · Safe request the frontend sends.** Only domain inputs; the token carries the
identity. No IDs, no Query DSL.

```http
POST /api/search
Authorization: Bearer <dev JWT for USR-001-C>
Content-Type: application/json

{ "vehicle_class": "suv", "sort": "personalized_price_asc" }
```

**2 · Controlled Query DSL the backend builds** (`buildInventoryQuery`). No text
query here, so no `multi_match`; a `customer_user` gets **no** dealership filter.
`_source` is an explicit allow-list.

```json
POST inventory/_search
{
  "size": 200,
  "_source": ["inventory_id","dealership_id","dealership_name","dealership_city",
              "make","model","vehicle_class","description","seats","fuel_type",
              "quantity_available","base_daily_rate","status"],
  "query": {
    "bool": {
      "filter": [
        { "range": { "quantity_available": { "gt": 0 } } },
        { "term": { "vehicle_class": "suv" } }
      ],
      "must_not": [ { "term": { "status": "unavailable" } } ]
    }
  },
  "sort": [ { "base_daily_rate": "asc" }, { "inventory_id": "asc" } ]
}
```

Separately, **one** agreements query — the `customer_id` comes from the token, not
the request (`getActiveAgreementsForCustomer`):

```json
POST customer_agreements/_search
{
  "size": 100,
  "_source": ["dealership_id","vehicle_class","discount_percent",
              "agreement_status","valid_from","valid_to"],
  "query": { "bool": { "filter": [
    { "term":  { "customer_id": "CUS-001" } },
    { "term":  { "agreement_status": "active" } },
    { "range": { "valid_from": { "lte": "2026-07-16" } } },
    { "range": { "valid_to":   { "gte": "2026-07-16" } } }
  ] } }
}
```

**3 · Inventory document OpenSearch returns** (one hit, `_source` limited to the
requested fields):

```json
{
  "_index": "inventory",
  "_id": "INV-CHI-SUV-01",
  "_source": {
    "inventory_id": "INV-CHI-SUV-01",
    "dealership_id": "DLR-CHI",
    "dealership_name": "Chicago Central Fleet",
    "dealership_city": "Chicago",
    "make": "Ford",
    "model": "Explorer",
    "vehicle_class": "suv",
    "description": "Three-row SUV for crews, mixed terrain, and jobs requiring passenger and cargo flexibility.",
    "seats": 7,
    "fuel_type": "gasoline",
    "quantity_available": 4,
    "base_daily_rate": 92,
    "status": "available"
  }
}
```

**4 · Final redacted, personalized API response.** The pricing service applies the
28% dealership-wide agreement (`92 × (1 − 0.28) = 66.24`); the DTO mapper drops
`dealership_id`, `seats`, `fuel_type`, `status`, and all OpenSearch metadata —
and no agreement id or `customer_id` ever appears.

```json
{
  "role": "customer_user",
  "pricing": "personalized",
  "sort": "personalized_price_asc",
  "count": 10,
  "results": [
    {
      "inventory_id": "INV-CHI-SUV-01",
      "dealership_name": "Chicago Central Fleet",
      "dealership_city": "Chicago",
      "make": "Ford",
      "model": "Explorer",
      "vehicle_class": "suv",
      "description": "Three-row SUV for crews, mixed terrain, and jobs requiring passenger and cargo flexibility.",
      "quantity_available": 4,
      "base_daily_rate": 92,
      "effective_daily_rate": 66.24,
      "discount_percent": 28,
      "pricing_source": "customer_agreement",
      "agreement_applied": true
    }
  ]
}
```

The `personalized_price_asc` ordering is applied in the service *after* pricing, so
Chicago's discounted `$66.24` can outrank a dealership with a lower base rate.

---

## 6. Threat scenarios → mitigations

| Attempt | Result | Control |
| --- | --- | --- |
| Call `/api/search` with no token | `401` | Checkpoint 1 |
| Use a token for a now-inactive user | `403` | Checkpoint 1 (active re-check) |
| Tamper with / forge the token | `401` (signature fails) | Checkpoint 1 |
| `customer_user` sends `{ "customer_id": "CUS-OTHER" }` | `400`; identity never read from body | Checkpoints 2 + 4 |
| `dealership_user` sends `{ "dealership_id": "DLR-OTHER" }` | `400`; scope filter comes from token | Checkpoints 2 + 3 |
| Send raw Query DSL or a custom `sort`/`_source` | `400` | Checkpoint 2 |
| Try to read another customer's agreements | no endpoint returns agreements; pricing uses token customer only | Checkpoint 4 |
| Expect internal fields (`_id`, agreement rows) in results | absent — DTO is an allow-list | Checkpoint 4 |

Each row corresponds to an automated test in `backend/test/` (see the test summary
in the README); the authorization and pricing behavior is regression-guarded.

> **Production note — operations.** **Audit logging** (every authorization decision
> and agreement access) and **rate limiting / anomaly detection** belong around the
> protected API surface.

---

## 7. Defense in depth: production summary

The inline **Production notes** above cover each area in context; consolidated as a
checklist, a production build would add — all *beneath* the application boundary,
never replacing it:

- **Identity** — a real OIDC/SAML provider (refresh/rotation, MFA) in place of the
  mock dev-session endpoint; the app still maps identities to roles/tenants.
- **Datastore** — per-tenant OpenSearch service identities + DLS/FLS for overlapping
  isolation.
- **Operations** — audit logging and rate limiting around the protected API.
- **Pricing at scale** — materialized per-customer offers, which would also let the
  engine sort by personalized price (today that re-rank is in the service).

---

## National-scale extension: search vs. procurement

The implemented **Basic Search** answers a *regional inventory* question — "rank the
available SUVs, priced for this customer." A **Procurement Search** answers a
*multi-site sourcing* question — "supply 50 pickups across 12 job sites." These are
different problems: ranking individual results vs. **allocating demand across many
locations**.

> **Procurement Search is a future conceptual workflow.** The current backend does
> **not** perform multi-site allocation. The Procurement tab is a frontend-only
> mockup rendering a static sample plan; no allocation/optimization runs.

A request like *"50 pickups across 12 job sites"* would extend — not replace — the
same pipeline shown above:

1. **OpenSearch candidate retrieval** — eligible inventory per region (the same
   controlled, tenant-scoped query, run across locations).
2. **Customer-specific pricing** — the same application-layer agreement resolution,
   applied to every candidate.
3. **A future allocation / optimization stage** — assign quantities across
   dealerships to meet demand under an objective (cost, fulfillment, count…).
4. **Inventory + final-price revalidation before booking** — re-check availability
   and recompute prices at commit time, since both can move between plan and book.

**Split fulfillment across dealerships** means combining inventory from *more than
one* dealership to satisfy a single demand line. Example: 20 pickups needed, but the
nearest dealership has 12 — with split fulfillment on, the plan sources 12 there and
8 from the next-best location; with it off, that line is single-sourced and the
remaining 8 show as unmet.

---

## 8. Code map

| Concern | File |
| --- | --- |
| Trusted identity shape | `backend/src/domain/types.ts` |
| Token sign / verify | `backend/src/auth/session.ts` |
| Auth gate + active re-check | `backend/src/auth/middleware.ts` |
| Mock identity endpoints (dev only) | `backend/src/routes/devSession.ts` |
| Input allow-list | `backend/src/validation/searchSchema.ts` |
| Controlled query + mandatory tenant filter | `backend/src/services/searchService.ts` |
| Own-customer agreement retrieval | `backend/src/services/agreementService.ts` |
| Pricing precedence + formula | `backend/src/services/pricingService.ts` |
| Orchestration + pricing scope + re-rank | `backend/src/services/protectedSearch.ts` |
| DTO redaction (field allow-list) | `backend/src/dto/mapResults.ts` |
| Authorization & pricing tests | `backend/test/*.test.ts` |
