# CallTrove (Prototype)

Solves a specific, confirmed problem: GHL's downloaded call recordings carry
no embedded metadata (no timestamp, no caller info, just a GUID filename).
This app watches for completed calls in a GHL sub-account, pulls the
recording and its metadata, embeds that metadata directly into the audio
file, and stores everything in an organized, searchable, per-contact call
history with role-based access (admins see everything; regular users see
only calls they personally handled).

**Phase**: prototype. No real client/PHI data, no HIPAA/compliance layer yet
(BAAs, encryption-at-rest specifics, audit logging are all deliberately
phase 2). This phase proves the pipeline works end to end for one account.

## Architecture

- `src/poller.js` — polls GHL's Conversations API every 60s for new call
  messages across the whole sub-account (not a GHL workflow/webhook — see
  "Why polling, not a webhook" below), writes a `calls` row, downloads the
  recording, embeds metadata into it, and stores it.
- `src/ghlApi.js` — all GHL REST API access: listing conversations/call
  messages, downloading a recording, resolving the account's timezone and
  user list.
- `src/audioMetadata.js` — embeds call metadata (timestamp in the account's
  own timezone, direction, duration, contact) into the recording file
  itself (RIFF INFO tags for WAV, ID3v2 for MP3) — this is what actually
  solves the "no metadata" problem, not just showing it in the dashboard.
- `src/auth.js`, `src/routes/auth.js`, `src/routes/admin.js` — login
  sessions and admin-only user management (create/reset-password/delete
  accounts, map each to a GHL user for access control).
- `GET /api/contacts`, `GET /api/contacts/:id/calls`, `GET /api/calls/:id/recording`
  — read API backing the dashboard, scoped by the logged-in user's role.
- `public/` — static dashboard (login, contact search + call history with
  playback/download, admin user management, change password).
- Postgres for metadata (`src/db`), pluggable storage for recordings
  (`src/storage`: local disk by default, S3 when `STORAGE_DRIVER=s3`).
- `src/transcription.js`, `src/transcriptionPoller.js` — optional call
  transcription via AWS Transcribe (`TRANSCRIPTION_ENABLED=true`), a
  meaningful undercut of GHL's own transcription fee — see "Call
  transcription" below.
- `src/backfill.js` — one-off/on-demand script that walks a sub-account's
  entire call history (the live poller deliberately doesn't) — see
  "Historical backfill" below.

Built on Node/Express/Postgres so it can move to AWS (API Gateway + Lambda
or ECS, RDS, S3) later without a re-platform — the eventual HIPAA-compliant
version will run on AWS anyway (for Bedrock/Claude access under AWS's BAA).

## Why polling, not a webhook

GHL's "Call Completed" workflow trigger has no recording-URL field at all
(confirmed against GHL's own docs), needs a hand-built JSON body with
merge tags that are easy to get wrong (field names vary by trigger/version,
and unresolved tags render as the literal string `"null"`), and requires
every customer to manually build that workflow in their own account. The
Conversations API GHL exposes already has everything needed — real message
IDs, proper ISO timestamps (no timezone ambiguity), who handled the call,
duration, direction — so this app scans it directly instead. Zero manual
GHL setup per account; more reliable than depending on a webhook body being
configured exactly right.

## Local setup

```bash
cp .env.example .env       # fill in GHL_API_TOKEN, GHL_LOCATION_ID, SESSION_SECRET
docker compose up -d       # starts local Postgres
npm install
npm run migrate            # applies src/db/schema.sql
npm run dev
```

The dashboard is served at `http://localhost:3000/`. There's no self-signup —
create the first admin account directly:

```js
node -e '
require("dotenv").config();
const { randomUUID } = require("crypto");
const db = require("./src/db");
const { hashPassword } = require("./src/auth");
(async () => {
  const { hash, salt } = hashPassword("changeme123");
  await db.createUser({ id: randomUUID(), username: "admin", passwordHash: hash, passwordSalt: salt, role: "admin" });
  await db.pool.end();
})();
'
```

Log in, then use **Manage users** to create accounts for your team, mapping
each to their GHL identity (picked from a live dropdown of GHL users) so
their calls route correctly.

## GHL setup

Generate a Private Integration token: **Settings → Private Integrations →
Create**, with scopes `conversations.readonly`, `conversations/message.readonly`,
`locations.readonly`, and `users.readonly`. Put the token and the
sub-account's Location ID in `.env`. That's it — no workflow to build, no
webhook URL to configure. The poller starts watching automatically as soon
as the server boots with those set.

## Call transcription

Optional (`TRANSCRIPTION_ENABLED=true`), via AWS Transcribe, **on-demand
only** — a "Transcribe" button per call in the dashboard, nothing automatic.
Most calls never get relistened to, so auto-transcribing every single one
(the live poller's ingestion, and `src/backfill.js`'s history walk) would
mean paying for a lot of transcripts nobody asked for. Triggering it is a
deliberate, visible action instead, which also doubles as real cost control
to point to when selling this.

GHL charges $0.039/min for its own call transcription (confirmed directly
in the GHL UI); AWS Transcribe's cost is ~$0.024/min, so this alone
undercuts it, with room to price well below GHL's rate and still carry a
healthy margin.

Deepgram was the other option on the table (~$0.004/min, roughly 6x
cheaper still) but was passed over for one reason: **BAA turnaround.** AWS
will sign a BAA self-serve, in AWS Artifact, covering the whole account —
already needed for RDS/S3/EC2 once real PHI is in play. Deepgram's BAA is
sales-negotiated with no guaranteed turnaround, which is a bad position to
be in exactly when a customer is asking about HIPAA compliance. One AWS BAA
covering everything beat a cheaper per-minute rate riding on a second
vendor relationship.

Mechanically: clicking "Transcribe" hits `POST /api/calls/:id/transcribe`,
which pulls the stored recording back out (`storage.getBuffer()`, regardless
of `STORAGE_DRIVER`) and hands it to `src/transcription.js`. AWS Transcribe
only accepts audio from S3, never raw bytes, so that module uploads it to a
transient S3 key and starts an async job. Jobs aren't instant, so
`src/transcriptionPoller.js` checks outstanding jobs every 30s; on
completion the transcript text is saved to Postgres (`calls.transcript`)
and the transient S3 copy + AWS's own job record are deleted. The button
becomes a "Transcribing…" state, then a "View transcript" toggle once
ready.

The vendor call is isolated behind `src/transcription.js`'s
`isEnabled()` / `startJob()` / `checkJob()` interface specifically so
swapping providers later (Deepgram once/if its BAA process is sorted, or
anything else) only means writing a new module behind the same interface,
not touching the poller or API routes that call it.

## Historical backfill

GHL lets sub-accounts turn on auto-deleting call recordings after N days
(default 90) to control their own storage bill, and that setting reportedly
can't be turned back off once enabled. The live poller (`src/poller.js`)
deliberately starts watching from "now" on first run rather than walking
the whole account, so on its own it wouldn't catch anything recorded before
CallTrove was installed — a real gap once a customer flips that switch on.

`src/backfill.js` (`npm run backfill`) closes that gap: it walks the
account's *entire* conversation history, oldest calls first (so if it gets
interrupted partway, whatever's closest to falling out of GHL's retention
window is already saved), through the same download/tag/store pipeline the
live poller uses. It's safe to run more than once or alongside the live
poller — `calls.ghl_call_id` is unique, so anything already captured is
just skipped.

Like everything else, it never triggers transcription — that's on-demand
only, everywhere (see "Call transcription" above). Storing the raw
backfilled recordings is essentially free (~1MB/min of audio costs a
fraction of a cent/month on S3, so backfilling years of history is a
non-issue), but transcribing all of it would not be — at AWS Transcribe's
rate, a 10,000-minute backlog is a real ~$240 one-time bill, which is
exactly why that stays a deliberate per-call click, not a side effect of
"go save everything before it's deleted."

Run this once per sub-account at onboarding, or any time before telling a
customer it's safe to turn GHL's auto-delete setting on. It can only save
what GHL still has — anything already past the deletion window before this
runs is unrecoverable.

## Definition of done for this phase

- A real call in the GHL sub-account is picked up by the poller within
  ~60 seconds, with no manual trigger.
- The recording is downloaded, tagged with metadata, and stored
  (`data/recordings/` locally, or S3).
- A `calls` row is created with accurate, complete metadata — this is the
  core proof point, since correct metadata is the entire problem being solved.
- The dashboard shows the call under the right contact with working
  playback and download, visible to the right users based on role.

## Deferred to later phases (intentionally not built yet)

- HIPAA compliance: encryption-at-rest specifics, BAAs, audit logging,
  retention policies.
- AI analysis of calls beyond raw transcription (summaries, sentiment,
  coaching scores).
- True multi-tenancy (one deployment serving multiple GHL sub-accounts with
  isolated data) — this prototype is one deployment per sub-account.
- Formal GHL Marketplace app packaging / OAuth (needed if this is ever sold
  as an installable marketplace app instead of deployed per-customer).
- Email-based "forgot password" flow (needs SES or similar); today, users
  change their own password from `/account.html`, and admins can reset
  anyone's from `/admin.html`.

## Moving to AWS

The storage layer already speaks S3 (`STORAGE_DRIVER=s3`, `S3_BUCKET`,
`S3_REGION`, standard AWS SDK credential chain — no code changes needed).
For the database, point `DATABASE_URL` at an RDS Postgres instance. For
compute, the Express app (poller included, since it runs in-process) can
run as-is on EC2/ECS/App Runner.
