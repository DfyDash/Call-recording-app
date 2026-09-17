// Walks a sub-account's ENTIRE call history and runs it through the same
// pipeline the live poller uses (download recording, embed metadata, store)
// -- unlike the poller, which deliberately starts watching from "now" on
// first run. This exists for one reason: GHL lets accounts turn on
// auto-deleting call recordings after N days, and that setting reportedly
// can't be turned back off once enabled. Anything not captured before that
// window closes is gone for good, so this needs to run (once, or any time
// there's a gap) before telling a customer it's safe to flip that switch on.
//
// Transcription is on-demand only, everywhere (see routes/api.js's POST
// /calls/:id/transcribe) -- this never triggers it either. Run it with
// node src/backfill.js (or npm run backfill).

require("dotenv").config();
const db = require("./db");
const ghlApi = require("./ghlApi");
const { processCallMessage } = require("./poller");

const PAGE_SIZE = 100;
const DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 250);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  if (!ghlApi.isConfigured()) {
    console.error("[backfill] GHL_API_TOKEN / GHL_LOCATION_ID not set, aborting");
    process.exitCode = 1;
    return;
  }

  console.log("[backfill] starting full history walk (oldest calls first)");

  let cursor = {};
  let pageNum = 0;
  let conversationsSeen = 0;
  let callsFound = 0;
  let callsSaved = 0;
  let callsSkipped = 0;
  let callsFailed = 0;

  for (;;) {
    pageNum += 1;
    const conversations = await ghlApi.searchConversationsPage({
      limit: PAGE_SIZE,
      sort: "asc",
      ...cursor,
    });
    if (conversations.length === 0) break;

    console.log(`[backfill] page ${pageNum}: ${conversations.length} conversations`);

    for (const conversation of conversations) {
      conversationsSeen += 1;
      let messages;
      try {
        messages = await ghlApi.listCallMessages(conversation.id);
      } catch (err) {
        console.error(`[backfill] failed to list messages for conversation ${conversation.id}:`, err);
        continue;
      }
      await sleep(DELAY_MS);

      for (const message of messages) {
        callsFound += 1;
        const before = await db.getCallByGhlId(message.id);
        if (before) {
          callsSkipped += 1; // already captured by a prior run or the live poller
          continue;
        }
        try {
          await processCallMessage(conversation, message);
          callsSaved += 1;
        } catch (err) {
          callsFailed += 1;
          console.error(`[backfill] failed to process call ${message.id}:`, err);
        }
        await sleep(DELAY_MS);
      }
    }

    const last = conversations[conversations.length - 1];
    cursor = { startAfterDate: last.lastMessageDate, startAfterId: last.id };

    if (conversations.length < PAGE_SIZE) break; // short page = last page
  }

  console.log(
    `[backfill] done. conversations scanned: ${conversationsSeen}, call messages found: ${callsFound}, ` +
      `saved: ${callsSaved}, already had: ${callsSkipped}, failed: ${callsFailed}`
  );
}

run()
  .catch((err) => {
    console.error("[backfill] fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
