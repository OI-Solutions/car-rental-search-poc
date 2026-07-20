# Session Handoff

Purpose: resume this project on another machine. Last updated 2026-07-17.

> This file is committed (public repo) and contains **no secrets**. Private
> deployment specifics (server access, keys) live in `DEPLOYMENT-PRIVATE.md`,
> which is git-ignored and must be transferred separately — it is **not** in git.

## Where things stand

A working B2B car-rental search POC in two phases, plus a teaching/demo layer.

- **Phase 1 — OpenSearch environment** (`docker-compose.yml`, `opensearch/`, `scripts/`):
  single-node OpenSearch + Dashboards, explicit mappings, idempotent ingestion,
  verification. Data: `data/*.json` (5 dealerships, 50 inventory, 12 customers,
  36 agreements, 19 users).
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

Repo: `OI-Solutions/car-rental-search-poc` (public). Branch `main`.

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

## Next objective: try AWS serverless

**Status update**: the retrieval-backend half of this (real Amazon OpenSearch Serverless
instead of fixture mode) is done — see the "OpenSearch Serverless support" bullet above.
The narrower path was chosen deliberately over the full rearchitecture below: an existing
demo deployment was already live on a small always-on EC2 box (details in the git-ignored
`DEPLOYMENT-PRIVATE.md`), so only the search backend was swapped, leaving hosting as-is.
The Lambda/API Gateway/S3/CloudFront rearchitecture proposed below **remains undone** and
is still a reasonable future direction if hosting itself needs to move off that box.

Goal: host this serverless on AWS. The app is already factored to make this easy —
`backend/src/app.ts` exports `createApp()` (no `listen`), and retrieval is behind a
swappable client (`opensearch` | `fixture`).

**Proposed architecture (options + recommendation):**

| Piece | Options | Recommended first pass |
| --- | --- | --- |
| Frontend | S3 + CloudFront, or Amplify Hosting | S3 + CloudFront (static Vite build) |
| API | Lambda + API Gateway (wrap `createApp()` with a serverless-http adapter), App Runner, or Fargate | **Lambda + API Gateway** |
| Search | Amazon **OpenSearch Serverless** collection (IAM/SigV4), or `fixture` mode | **Start in `fixture` mode**, then swap to OpenSearch Serverless |
| Secrets/config | Lambda env vars + SSM Parameter Store / Secrets Manager | SSM for `JWT_DEV_SECRET`; IAM role for search |
| IaC | AWS SAM, CDK, or Serverless Framework | SAM or CDK |

**Recommended sequence:**
1. **Stand up the plumbing in fixture mode first** — Lambda(`createApp()`) + API
   Gateway + static frontend on S3/CloudFront, `SEARCH_BACKEND=fixture`. Proves the
   whole serverless path with zero cluster cost.
2. **Then swap retrieval to OpenSearch Serverless** — provision a collection, load
   data, point the backend at it.

**Concrete first steps:**
- Add a Lambda entry, e.g. `backend/src/lambda.ts`, wrapping `createApp()` with
  `serverless-http` (or `@codegenie/serverless-express`). Bundle with esbuild
  (project is ESM: `"type": "module"`).
- Pick IaC (SAM template or CDK app) defining: the API Lambda + HTTP API, the S3
  bucket + CloudFront for the frontend, and env/secret wiring.
- Set `CORS_ORIGIN` to the CloudFront domain; `VITE_API_BASE_URL` to the API URL.

**Gotchas to remember:**
- **OpenSearch Serverless auth is IAM + SigV4, not basic-auth.** The Phase 1
  security-plugin / `admin` password model does **not** apply. Both clients change:
  - Node: use `@opensearch-project/opensearch` with `AwsSigv4Signer` in
    `backend/src/opensearch/client.ts` (add a third backend branch or config path).
  - Python ingestion: use `opensearchpy`'s `AWSV4SignerAuth` in `scripts/common.py`.
- OpenSearch Serverless has API/behavior differences (data-access policies; no
  identical `_cluster/health`). Expect small adjustments in `wait_for_opensearch.py`.
- Lambda cold starts are fine for a demo. Keep the bundle small.
- Auth is still a **mock** dev JWT — fine for a demo, but call it out; a real deploy
  would front it with Cognito/OIDC. Don't expose the `explain` payload in a real
  posture.

**Open decisions for next session:**
- SAM vs CDK vs Serverless Framework.
- Fixture-only demo vs full OpenSearch Serverless.
- Whether to put the API behind Cognito now or keep the mock JWT for the demo.

## Key files to reorient quickly
- `docs/ACCESS_CONTROL.md` — the design/authorization write-up (start here).
- `backend/src/app.ts` / `services/protectedSearch.ts` — request flow + orchestration.
- `backend/src/opensearch/client.ts` + `config.ts` — retrieval backend selection.
- `frontend/src/components/UnderTheHood.tsx` — the Explain-mode inspector.
- `DEPLOYMENT-PRIVATE.md` (local, not in git) — your private deployment notes.
