# Session Handoff

Purpose: resume this project on another machine. Last updated 2026-07-20.

> This file is committed (public repo) and contains **no secrets**. Private
> deployment specifics (server access, keys) live in `DEPLOYMENT-PRIVATE.md`,
> which is git-ignored and must be transferred separately — it is **not** in git.

## Where things stand

A working B2B car-rental search POC in two phases, plus a teaching/demo layer.

- **Phase 1 — OpenSearch environment** (`docker-compose.yml`, `opensearch/`, `scripts/`):
  single-node OpenSearch + Dashboards, explicit mappings, idempotent ingestion,
  verification. Data: `data/*.json` (12 dealerships, 1,520 inventory, 12 customers,
  62 agreements, 26 users) — see **Data provenance** below.
- **Phase 2 — protected personalized search** (`backend/`, Express + TS): mock JWT
  sessions, role/tenant authorization, controlled OpenSearch queries, per-customer
  pricing, redacted DTOs. **34 tests pass** (3 live-integration tests skip when no
  cluster). Design write-up: `docs/ACCESS_CONTROL.md` (sequence diagram, worked
  example, threat model, code map).
- **Frontend** (`frontend/`, React + Vite): identity switcher, Basic Search,
  Procurement Search (frontend-only mockup), synthetic-data pulldown, and an
  **"Explain mode"** inspector that shows the real query / redaction / pricing.
- **Fixture backend**: `SEARCH_BACKEND=fixture` serves `data/*.json` from memory so
  the API runs with **no Docker / no cluster** (only free-text relevance is
  approximated). Everything above retrieval is the real code path.
- **OpenSearch Serverless support**: `OPENSEARCH_AUTH_MODE=sigv4` (alongside the existing
  `basic` mode) makes the retrieval client and the Python ingestion scripts authenticate
  via AWS SigV4 instead of security-plugin username/password — required by Amazon
  OpenSearch Serverless. Node uses `@opensearch-project/opensearch/aws-v3` +
  `@aws-sdk/credential-provider-node`; Python uses `opensearchpy`'s `AWSV4SignerAuth` +
  `boto3`. Two Serverless API gaps worth remembering: no `_cluster/health`/`GET /` (use
  `indices.exists` for readiness checks instead), and index creation must omit an explicit
  `settings` block (shard/replica counts aren't configurable there —
  `scripts/create_indexes.py` strips it automatically in `sigv4` mode). A demo deployment
  now uses this for genuine BM25 retrieval instead of the fixture approximation; private
  deployment specifics (host, collection id, credentials) live in the git-ignored
  `DEPLOYMENT-PRIVATE.md`, not here.
- **Demo UI refinements**: Basic Search dropped the free-text query field and the
  "Relevance" sort option (nothing produces a live BM25 scoring case without a
  text query, so it was a dead option) — default sort is now base price. Added a
  short callout above Basic Search explaining the authorization flow in plain
  language, and restyled the "Explain mode" checkbox into a clearly labeled
  button ("Inspect this search") so the existing `UnderTheHood.tsx` inspector is
  easy to point to live instead of an easy-to-miss checkbox.

Repo: `OI-Solutions/car-rental-search-poc` (public). Branch `main`.

## Data provenance

The `data/*.json` inventory is derived from the **Cornell Car Rental dataset**
(Kaggle: `kushleshkumar/cornell-car-rental-dataset` — ~5,851 real Turo listings).
`scripts/build_from_cornell.py` transforms it into the project's normalized source
files: the **top 12 metros become dealerships** (fleet locations, centroid geo),
each real listing becomes an inventory row, and distinct (make, model, class)
combos become vehicle models. The **B2B tenant layer is still synthetic** — no
public dataset has negotiated/tiered pricing — so customers, tiered agreements
(dealership-wide + class-specific), and users are generated on top, deterministic
(`SEED=42`), engineered to include a base-vs-personalized **price inversion** and
an intentionally inactive customer (`CUS-012`).

- Raw CSV lives in `data/source/` (**git-ignored**). On a fresh machine, download
  the Kaggle dataset and unzip `CarRentalDataV1.csv` there, then:
  `python scripts/build_from_cornell.py [--metros 12]` (metro count is a knob).
- `scripts/validate_data.py` guards referential integrity + the price inversion;
  `backend/test/fixtureClient.test.ts` and `auth.test.ts` pin dataset invariants
  (Las Vegas dealership scoping, `CUS-012`/`USR-012-C` inactive). Regenerating with
  different `--metros` may require re-pinning those anchors.
- `data/README.md` still describes the original hand-built synthetic set; the
  older `scripts/generate_data.py` only reformats existing files.

## Scale & data-modeling benchmark

`docs/SCALE_AND_JOINS.md` is a standalone artifact answering "why denormalized,
not parent/child, at scale." It builds **two isolated OpenSearch indexes**
(`bench_flat`, `bench_join`) from ~2M rows seeded from Cornell and measures them.
It requires the **local OpenSearch cluster** (not the fixture, which can't do
millions or real join queries). The app and its tests never touch `bench_*`.

```bash
docker compose up -d && python scripts/wait_for_opensearch.py
python scripts/bench_generate_ingest.py --target 2000000   # builds both indexes (~80s ingest)
python scripts/bench_run.py --iterations 30                 # prints table, writes scripts/bench_results.json
```

Finding (2M rows, single local node): filters prune ~99.5% of the space, so search
stays fast either way; but a **broad model-attribute filter** (`class=suv`, 611k
matches) makes parent/child **~13.5× slower** (join must resolve parent→child
across all matches) — while denormalization pays **+32% storage** (517 vs 391 MB)
for that read speed. Global-ordinals heap is ~0 at 547 parents (grows with parent
cardinality). Surfaced three ways: the doc, a published chart artifact, and a
collapsible "scale note" panel in `frontend/src/components/UnderTheHood.tsx`.

- Files: `scripts/bench_generate_ingest.py`, `scripts/bench_run.py`,
  `opensearch/mappings/bench_{flat,join}.json`, `scripts/bench_results.json`.
- Tear down the benchmark data: `curl -k -u admin:$PW -XDELETE https://localhost:9201/bench_flat,bench_join`
  (or `docker compose down` to stop the whole cluster).

## Resume on a new machine

```bash
git clone https://github.com/OI-Solutions/car-rental-search-poc
cd car-rental-search-poc
cp .env.example .env            # .env is git-ignored; recreate it here

# Backend
cd backend && npm install
# Frontend
cd ../frontend && npm install
```

**Run without a cluster (fastest):**
```bash
cd backend && SEARCH_BACKEND=fixture npm run dev     # API on :4000
cd frontend && npm run dev                           # UI on :5173
```

**Run with real OpenSearch:**
```bash
docker compose up -d                       # starts OpenSearch + Dashboards
python scripts/wait_for_opensearch.py
python scripts/create_indexes.py
python scripts/ingest_data.py              # fresh machine → indexes start empty
cd backend && npm run dev                  # defaults to SEARCH_BACKEND=opensearch
```

Notes:
- **Local OpenSearch data lives in the named Docker volume `opensearch-data`.** On
  the *same* machine it survives restarts (`docker compose up -d` — no re-ingest).
  On a *new* machine there is no volume, so create indexes + ingest once.
- Local dev currently maps OpenSearch to host port **9201** (see `.env`), because
  another container used 9200.
- Verify: `cd backend && npm test`; `cd frontend && npm run build`.

## Previously completed: AWS serverless retrieval

The retrieval-backend half of "try AWS serverless" (real Amazon OpenSearch Serverless
instead of fixture mode) is **done** — see the "OpenSearch Serverless support" bullet
above. The narrower path was chosen deliberately over a full Lambda/API Gateway/S3/
CloudFront rearchitecture: an existing demo deployment was already live on a small
always-on EC2 box (details in the git-ignored `DEPLOYMENT-PRIVATE.md`), so only the
search backend was swapped, leaving hosting as-is. The full serverless-hosting
rearchitecture (Lambda + API Gateway for the API, S3 + CloudFront for the frontend)
remains **undone** and is still a reasonable future direction if hosting itself ever
needs to move off that box — ask for the detailed proposal (options table, IaC choice,
gotchas) if that becomes relevant again; it's been trimmed from this file to keep focus
on the current objective below.

A CloudFront-in-front-of-the-EC2-box option (to mask the real hostname behind a
`*.cloudfront.net` link) was also explored and **blocked**: the AWS account needs
manual verification via an AWS Support case before it can create CloudFront
distributions. Dropped for now — not worth chasing unless the account gets verified
later. If picked back up: front `theoption.life` as a custom origin (HTTPS-only,
CloudFront forwards the origin hostname so nginx's vhost matching still works), and
change `VITE_API_BASE_URL` to a relative `/crs-api` path so the frontend works
identically under either domain.

## Next objective: build a local at-scale proof of concept + performance/design report

**Why**: a call surfaced skepticism about whether the authorization architecture
holds up at national scale — specifically "what if a search has to sort millions of
rows." The honest answer (see the design discussion below) is that no interactive
product ever sorts millions of rows for display; the real technique is bounding the
candidate set via retrieval size before the expensive per-customer step, which this
codebase already does in miniature (`MAX_RESULTS = 200` in
`backend/src/services/searchService.ts`). The goal now is to **prove that with real
numbers** instead of asserting it, using a real large dataset — entirely local, to
avoid AWS Serverless OCU cost while iterating.

**Chosen approach** (decided, not yet started):
- **Local OpenSearch via Docker Desktop**, reusing the existing Phase 1
  `docker-compose.yml` setup (not the standalone no-Docker option — Docker Desktop
  was explicitly preferred for this).
- **Dataset**: the Kaggle "US Used Cars Dataset"
  (`kaggle.com/datasets/ananaymital/us-used-cars-dataset`, ~3M rows, real US dealer
  city/state/zip + make/model/price) — **full ~3M rows**, not a subset (explicitly
  chosen over 100K/500K subsets for a more convincing "national scale" claim).
  Alternatives considered: AutoTrader Vehicle Listings Dataset (~1.4M, more recent),
  Craigslist Cars/Trucks Dataset (has lat/long directly), NHTSA vPIC API (official,
  free, good for canonicalizing make/model/vehicle-type reference data, not for
  volume).

**Blocked on** (both require the user's own hands — cannot be done by an agent):
1. **Docker Desktop install** — needs admin rights, likely WSL2 setup + a reboot.
2. **Kaggle dataset download** — needs a free Kaggle account login; the raw CSV is
   large (multi-GB) so plan for download time.

**Once unblocked, the work is:**
1. Verify Docker (`docker info`), bring up Phase 1 stack (`docker compose up -d`,
   `python scripts/wait_for_opensearch.py`).
2. Write a **new** transform/ingest script (the existing `scripts/ingest_data.py` is
   hardcoded to the tiny synthetic `data/*.json` files and denormalizes a known small
   shape — don't try to bend it to fit the Kaggle CSV's ~66 columns; write a sibling
   script). Inspect the actual CSV header first rather than trusting column names from
   memory. Map real dealer name+city+state+zip combinations into a `dealerships`-shaped
   index (replacing the current 5 hand-picked Chicago-area dealers with real national
   spread), and listings into an `inventory`-shaped index.
3. `customers` / `customer_agreements` still have to be synthetic (no public dataset
   has negotiated B2B rental discounts) — scale the existing synthetic generator up
   proportionally to match the larger real inventory.
4. Run it through the **real, already-built pipeline** (`create_indexes.py` pattern,
   the real `searchInventory`/`runProtectedSearch` code — no shortcuts) so results are
   credible, not staged.
5. **Benchmark and write up findings** covering: query latency across filter
   combinations, pagination depth behavior (`search_after` vs naive `from`/`size`),
   personalized-price bounded-retrieval re-ranking latency at real scale, index size /
   segment stats, single-node memory footprint. Report should be usable to bring back
   to the team from the call.

**Design talking points already worked out this session** (worth reusing verbatim in
the eventual report rather than re-deriving):
- **Why multiple indexes**: different document shapes, different change frequency
  (inventory churns constantly, reference data barely changes), different access
  patterns matching the authorization model, and denormalization avoiding query-time
  joins entirely.
- **Denormalization vs. nested vs. parent-child**: this project denormalizes
  (dealership fields copied into inventory docs at ingest) because dealership data is
  effectively static. Nested = sub-objects living inside and rewritten with one parent
  document. Parent-child (`join` field type) = genuinely separate, independently
  updatable documents related at query time — the most expensive relational option in
  OpenSearch, worth it only when the "parent" side changes frequently enough that
  denormalization's write-amplification cost would dominate. Not the right fit here.
- **Scaling personalized search isn't about sharding** (OpenSearch Serverless
  abstracts that away entirely — the real knob is OCU/compute capacity, not shard
  count) **and isn't really about filters either** — it's about bounding the candidate
  set via retrieval size (two-stage retrieve-then-rank: cheap broad retrieval, then
  expensive per-customer ranking only on a bounded top-N) before the personalized-price
  step, which is a universal pattern in large-scale ranking systems, not a shortcut.
- **Freshness**: push (event-driven, partial `_update`) for high-frequency fields like
  `quantity_available`; pull (scheduled sync) for low-frequency reference data; the
  application layer (never OpenSearch itself) owns keeping the index in sync with the
  real source-of-truth system, consistent with the project's broader "app layer owns
  everything above retrieval" thesis.

## Key files to reorient quickly
- `docs/ACCESS_CONTROL.md` — the design/authorization write-up (start here).
- `backend/src/app.ts` / `services/protectedSearch.ts` — request flow + orchestration.
- `backend/src/opensearch/client.ts` + `config.ts` — retrieval backend selection.
- `frontend/src/components/UnderTheHood.tsx` — the Explain-mode inspector.
- `DEPLOYMENT-PRIVATE.md` (local, not in git) — your private deployment notes.
