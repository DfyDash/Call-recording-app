# Call Recording Vault (Prototype)

Solves a specific, confirmed problem: GHL's downloaded call recordings carry
no embedded metadata (no timestamp, no caller info, just a GUID filename).
This app listens for completed calls in GHL, pulls the recording and its
metadata at the moment the call finishes, and stores everything in an
organized, searchable, per-contact call history.

**Phase**: prototype. No real client/PHI data, no HIPAA/compliance layer yet
(BAAs, encryption-at-rest specifics, access controls, audit logging are all
deliberately phase 2). This phase proves the pipeline works end to end.

## Architecture

- `POST /webhooks/ghl/call-completed` — ingestion endpoint GHL's workflow
  webhook action posts to. Verifies a shared token, upserts the contact,
  writes a `calls` row, downloads the recording from GHL's URL, and stores it.
- `GET /api/contacts`, `GET /api/contacts/:id/calls`, `GET /api/calls/:id/recording`
  — read API backing the dashboard.
- `public/` — a minimal static dashboard: contact search + call history with
  inline playback.
- Postgres for metadata (`src/db`), pluggable storage for recordings
  (`src/storage`: local disk by default, S3 when `STORAGE_DRIVER=s3`).

Built on Node/Express/Postgres so it can move to AWS (API Gateway + Lambda
or ECS, RDS, S3) later without a re-platform — the eventual HIPAA-compliant
version will run on AWS anyway (for Bedrock/Claude access under AWS's BAA).

## Local setup

```bash
cp .env.example .env       # edit WEBHOOK_TOKEN to a random string
docker compose up -d       # starts local Postgres
npm install
npm run migrate            # applies src/db/schema.sql
npm run dev
```

The dashboard is served at `http://localhost:3000/`. The webhook endpoint is
`http://localhost:3000/webhooks/ghl/call-completed?token=<WEBHOOK_TOKEN>`.

To let GHL reach your local machine while testing, tunnel it (e.g. `ngrok
http 3000`) and use the tunnel URL in the GHL workflow below.

## GHL workflow setup (manual, one-time, no code)

No Marketplace app, OAuth registration, or developer approval is needed for
this phase — GHL's native Webhook workflow action is available on any
regular sub-account.

1. In the GHL sub-account, go to **Automation → Workflows → Create Workflow**.
2. Add trigger: **Call Completed**.
3. Add action: **Webhook**.
   - URL: `https://<your-host>/webhooks/ghl/call-completed?token=<WEBHOOK_TOKEN>`
   - Method: `POST`
   - Body: JSON (default trigger payload is fine to start with)
4. Save and publish the workflow.
5. Place a real test call in the sandbox sub-account to fire it.

**Field names vary by GHL trigger/payload version.** The ingestion endpoint
logs the full raw payload on every request (`[webhook] received payload: ...`)
and tries several known field-name variants for contact id/name/phone, call
id, direction, duration, recording URL, and timestamp (see
`normalizePayload` in `src/routes/webhook.js`). After the first real test
call, check the server logs against GHL's current webhook docs and adjust
the variant list in `normalizePayload` if a field isn't being picked up.

## Definition of done for this phase

- A test call in the sandbox GHL sub-account triggers the workflow.
- The webhook fires and this app receives the payload (visible in logs).
- The recording is downloaded and stored (`data/recordings/` locally, or S3).
- A `calls` row is created with accurate, complete metadata — this is the
  core proof point, since correct metadata is the entire problem being solved.
- The dashboard shows the call under the right contact with working playback.

## Deferred to later phases (intentionally not built yet)

- HIPAA compliance: encryption-at-rest specifics, BAAs, access controls,
  audit logging, retention policies.
- Transcription / AI analysis of calls.
- Multi-tenant support for other agencies.
- Formal GHL Marketplace app packaging / OAuth.

## Moving to AWS

The storage layer already speaks S3 (`STORAGE_DRIVER=s3`, `S3_BUCKET`,
`S3_REGION`, standard AWS SDK credential chain — no code changes needed).
For the database, point `DATABASE_URL` at an RDS Postgres instance. For
compute, the Express app can run as-is on EC2/ECS/App Runner, or be wrapped
with `serverless-http` for API Gateway + Lambda if you want a Lambda-based
webhook receiver — neither is wired up yet since it wasn't needed to prove
the pipeline locally.
