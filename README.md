# SettleProof

Evidence-first auditing for Amazon settlement, transaction and inventory reports.
It parses a report, runs a set of audit rules over the normalised rows, and returns a
ranked list of things worth reviewing — every finding traceable back to the exact
source rows that produced it.

The product's core promise is restraint: it never claims Amazon owes you money.
Amounts are only marked **recoverable** when the uploaded file itself proves a
charge is wrong. Everything else is a **review prompt** with a visible confidence
level. When the data is not there, the tool says *insufficient evidence* instead
of guessing.

## Features

- **Report ingestion** — CSV, TSV, TXT and Excel (`.xlsx`/`.xls`). Detects encoding
  (UTF-8 / UTF-16 / Windows-1252), delimiter (comma, tab, semicolon, pipe) and maps
  Amazon column aliases automatically. Unmapped columns are reported.
- **Audit rules** — 12 rules covering reconciliation, fees, duplicates,
  reimbursements, storage, removals, currency and profitability (see below).
- **Traceable evidence** — each finding stores source row numbers and a capped
  sample of the raw rows, shown in the UI and included in exports.
- **Confidence model** — `high` / `medium` / `low` / `insufficient`. The UI never
  hides uncertainty.
- **Product costs** — per-SKU COGS so profit figures reflect product cost; without
  COGS, profitability is explicitly labelled unreliable.
- **Exports** — findings as CSV or JSON, plus a settlement summary CSV suitable for
  bookkeeping entries.
- **Accounts & workspaces** — scrypt password hashing, session cookies, CSRF
  protection, per-workspace data isolation and retention-based file cleanup.
- **Plans & billing** — free tier, monthly subscriptions and a one-off report
  price. Razorpay payment links and signature-verified webhooks when keys are
  configured; otherwise a manual-invoice mode records the intent without
  pretending a charge happened.
- **Value loop** — when a later settlement contains a reimbursement matching an
  earlier finding, it is auto-resolved and written to a value ledger, producing a
  monthly ROI report that shows the subscription paying for itself.
- **Recovery pipeline** — every finding moves through an explicit state machine
  (potential → evidence ready → seller review → submitted → Amazon confirmed →
  cash confirmed → closed). Only *cash confirmed* posts to the value ledger, so
  potential money is never presented as money received.
- **Actionable findings** — each finding explains what happened, why it matters,
  the evidence rows behind it, how the amount was calculated, and the single next
  step. The full evidence record is inspectable and exportable.
- **Reliable background jobs** — audits run outside the HTTP request, are recorded
  as retryable/idempotent jobs, and are retried (up to 3 attempts) after a crash.
- **Retention nudges** — audit-complete, recovery-detected and upgrade messages are
  queued in an email outbox. With no provider configured they stay queued; nothing
  is ever marked as sent when it was not.
- **Zero external calls** — no Amazon connection, no third-party services, no
  telemetry beyond an optional payment gateway. The app only touches its own
  SQLite file and upload directory.

## Quick start

```bash
# Install dependencies
npm install

# Start the server (defaults to http://localhost:3000)
npm start

# Development with auto-reload
npm run dev

# Run the test suite
npm test

# Run the end-to-end smoke test
npm run smoke
```

Open the app, create an account (or click **Try the live sample** on the landing
page), and upload a report. A synthetic sample lives at
`data/sample/settlement-sample.csv` and can be regenerated with
`node scripts/make-sample.js`.

## Configuration

All configuration is via environment variables. The server reads them from the
process environment; there is no automatic `.env` loading. To use a `.env` file,
start with Node's built-in support:

```bash
node --env-file=.env server/index.js
```

`npm start` runs `node server/index.js`, so export the variables first or use the
`--env-file` form above. See `.env.example` for the full list. The important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database and uploads |
| `APP_SECRET` | auto-generated | Session secret — **set this in production** |
| `RETENTION_DAYS` | `30` | Days before uploads are auto-deleted |
| `MAX_UPLOAD_BYTES` | `26214400` | Maximum upload size (25 MB) |
| `ALLOW_SIGNUP` | `true` | Set to `false` to close registration |
| `ADMIN_TOKEN` | — | Guards `POST /api/billing/admin/{activate,cancel}` |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Payment callback and referral links (https in production) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | — | Set both to take payments; otherwise manual mode |
| `RAZORPAY_WEBHOOK_SECRET` | — | Verifies `POST /api/billing/webhook/razorpay` |
| `REFERRAL_CREDIT` | `500` | Credit granted when a referral activates a paid plan |

## Plans, billing and the value loop

Three plans (`server/plans.js`): **Free** (2 audits/month, 14-day retention, CSV
export), **Seller** ($10/month, unlimited audits, COGS/profitability, 365-day
retention, all exports) and **Accountant** ($29/month, 10 workspaces/seats).
A single report can also be bought for **$10**. Findings are never hidden behind
a plan — only depth (COGS, exports, retention, seats) is gated, because a finding
you cannot see has no value.

- `GET  /api/billing/catalog` — public plan catalogue.
- `GET  /api/billing/entitlements` — current plan and usage for a workspace.
- `POST /api/billing/checkout` — creates a payment link (Razorpay) or a manual intent.
- `POST /api/billing/webhook/razorpay` — signature-verified plan activation.
- `POST /api/billing/admin/activate` — manually activate a plan (`x-admin-token`).
- `GET  /api/workspaces/:id/value` — value report: tracked recoveries, ROI, ledger.
- `POST /api/workspaces/:id/findings/:findingId/resolve` — record a seller-confirmed recovery.

The value loop (`server/value.js`) only counts a recovery when the seller's own
uploaded file contains the matching reimbursement, or the seller explicitly records
one. Deductions are matched by order ID first, then SKU for categories where a
reimbursement logically follows.

## Recovery pipeline (proof, not promises)

`server/recovery.js` is the single source of truth for a finding's lifecycle:

```
POTENTIAL → EVIDENCE_READY → SELLER_REVIEW → CLAIM_SUBMITTED
          → AMAZON_CONFIRMED → CASH_CONFIRMED → CLOSED
```

Side branches: `REJECTED`, `DISPUTED`, `EXPIRED`, `UNVERIFIED`. Each transition
records the actor, note, optional evidence/case reference and a timestamp in
`finding_events`, so a seller has a defensible audit trail. Invalid transitions are
rejected with `409`. Only `CASH_CONFIRMED` writes to the value ledger (`value_ledger`),
and only once per finding.

The dashboard separates **potential**, **submitted**, **Amazon-confirmed** and
**cash-confirmed** totals so the headline never inflates.

- `GET  /api/workspaces/:id/findings` — all findings with their recovery state.
- `POST /api/workspaces/:id/findings/:findingId/transition` — move a finding.
- `POST /api/workspaces/:id/findings/:findingId/resolve` — record cash received.

## Demo account

The landing page has **Try the live sample**, which calls `POST /api/demo`. It
creates a throwaway account (no reusable password) pre-loaded with the synthetic
sample settlement, and pre-loads a full recovery pipeline — one finding left as
potential, one submitted, one Amazon-confirmed and one cash-confirmed — so the whole
value loop is visible immediately. Demo accounts are rate-limited (10/hour/IP) and
use no real seller data. Regenerate the sample with `node scripts/make-sample.js`.

## Reliability & scaling

- Audits run off the request thread via `services/ingest.js` → `services/processAudit.js`.
- Each audit is a row in `audit_jobs`; processing is idempotent (prior findings for
  the audit are cleared first) and `services/auditJobs.js` retries failed jobs at
  boot and in the daily sweep, up to `max_attempts` (3).
- Responses carry an `X-Request-Id`; server errors return that id so a report can be
  correlated with logs.
- A daily lifecycle sweep queues at most one monthly value report per workspace and
  one unresolved-findings nudge per workspace per week, guarded by idempotency keys.
- Uploads are size-limited, rate limiting is applied globally and to auth/demo, large
  result sets are paginated, and hot columns are indexed.
- `GET /api/health` reports liveness for load balancers.

**PostgreSQL migration path.** All data access is centralised in `server/db.js`, which
uses synchronous `node:sqlite` calls (`get`, `all`, `run`, `tx`). To move to Postgres,
reimplement those four helpers against a pool, keep the same exported function names,
and translate the SQL placeholders (`?` → `$n`). Business logic in `services/`,
`billing.js`, `value.js`, `recovery.js` never writes SQL directly. For multi-instance
deployments also move uploads to shared object storage and replace the in-memory rate
limiter.

## Demo credentials

There are no shared static credentials. Use **Try the live sample** on the landing
page (or `POST /api/demo`) to get an isolated demo session; or create a normal account
and upload `data/sample/settlement-sample.csv`.

## Audit rules

| Rule | What it checks | Default confidence |
| --- | --- | --- |
| R001 | Row amounts vs the row's own stated total | high |
| R002 | Settlement rows vs the settlement total | high |
| R003 | Duplicate-looking charges or credits | medium |
| R004 | A sale with no matching fee row in the file | low |
| R005 | Referral fee outside a plausible share of the sale | medium |
| R006 | Refund whose order is not in the file | low |
| R007 | Negative inventory adjustment that may be reimbursable | medium |
| R008 | Storage fee far above the file median | low |
| R009 | Removal transaction with a non-positive quantity | low |
| R010 | Aged / long-term inventory charge | low |
| R011 | A settlement mixing more than one currency | high |
| R012 | SKU sold at a loss after fees (and COGS when known) | high if COGS known |

Data gaps (missing settlement ID, no amount columns, no SKU column, missing COGS,
no stated totals, empty file) are returned as separate `insufficient` findings
with rule IDs `R900`–`R906`.

> Note: R001 and R002 describe defects in the report data itself, not money owed.
> They are framed as data-integrity flags everywhere in the UI.

## Architecture

```
server/
  config.js            environment configuration + secret management
  db.js                SQLite schema and data access (node:sqlite, WAL)
  auth.js              scrypt hashing, sessions, CSRF (double submit)
  storage.js           upload storage, hashing, retention cleanup
  app.js               express app, middleware, route mounting, errors
  index.js             server bootstrap, retention sweep, graceful shutdown
  lib/                 logger, errors, validation, rate limiting, CSV
  parsers/             encoding/delimiter detection, RFC4180 parser, column mapping
  audit/               findings model, rules R001-R012, engine/orchestrator
  plans.js             plan catalogue, entitlements and feature gating
  billing.js           checkout, Razorpay webhooks, plan activation and expiry
  value.js             recovery detection, value ledger and ROI report
  recovery.js          recovery state machine, buckets, onboarding and health signals
  retention.js         email outbox nudges (lifecycle) + reliable flush
  routes/              auth, workspaces (+COGS, dashboard), audits, demo, billing, value
  services/            ingest pipeline, background audit processing, job retry, lifecycle sweep
public/                front end (no build step)
tests/                 parser, audit, value/billing, API, state-machine, jobs and smoke tests
```

The front end is served by the same Express process as the API (single origin), so
there is no CORS setup and no separate proxy to run.

## Security notes

- Passwords hashed with scrypt (N=16384), never stored in plain text.
- Sessions are opaque random tokens in `HttpOnly`, `SameSite=Lax` cookies;
  `Secure` in production.
- State-changing requests require a double-submit CSRF token.
- All workspace routes assert membership before touching data.
- Uploads are size-limited, extension-checked and stored outside the web root.
- Rate limiting on auth and demo endpoints.
- Central error handling never leaks stack traces to clients.

## Limitations (read this before trusting a number)

- The tool can only judge what is in the file you upload. Missing data is reported
  as a gap, not filled in.
- It does not connect to Amazon and cannot verify a claim against Amazon's systems.
- Rule thresholds (referral share, storage outlier multiplier) are heuristics and
  may need tuning for unusual catalogues.
- Profitability without COGS ignores product cost and is labelled accordingly.
- Payments require your own Razorpay account. Without keys the app runs in
  manual-invoice mode and never claims a payment succeeded.
- Recoveries are only as complete as the files you upload; a reimbursement that
  never appears in a settlement file cannot be detected.
- Email nudges need an email provider to actually send; until then they stay in
  the outbox.

## Deployment

Any Node.js 22.5+ host works. Set `APP_SECRET`, point `DATA_DIR` at a persistent
volume, and run `npm start`. The app opens the SQLite database itself; no separate
database server is required. For a multi-instance deployment behind a load
balancer, replace the in-memory rate limiter and move uploads to shared storage.
