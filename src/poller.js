const { randomUUID } = require("crypto");
const db = require("./db");
const ghlApi = require("./ghlApi");
const { saveRecording } = require("./storage");
const { embedMetadata } = require("./audioMetadata");

const POLL_INTERVAL_MS = 60 * 1000;
const CONVERSATIONS_PER_POLL = 100;

// Replaces the GHL "Call Completed" workflow/webhook entirely: scans for
// new call messages via GHL's own Conversations API on a timer instead of
// waiting for GHL to push one. This is more reliable than the webhook was
// (real message IDs instead of a synthetic fallback, proper ISO timestamps
// instead of GHL's ambiguous timezone-less strings, handled-by/duration/
// direction straight from the API instead of depending on a hand-built
// webhook JSON body) and needs zero manual setup in GHL per account.
// Transcription is deliberately not triggered here -- it's on-demand only
// (see routes/api.js's POST /calls/:id/transcribe), so nobody's paying to
// transcribe calls no one ever asked to read.
async function processCallMessage(conversation, message) {
  const contactId = conversation.contactId;
  if (!contactId) return;

  const occurredAt = new Date(message.dateAdded);
  const name = conversation.fullName || conversation.contactName || null;
  const phone = conversation.phone || null;

  await db.upsertContact({ contactId, name, phone });

  const callRowId = randomUUID();
  const inserted = await db.insertCall({
    id: callRowId,
    ghlCallId: message.id,
    contactId,
    direction: message.direction || null,
    durationSeconds: (message.meta && message.meta.call && message.meta.call.duration) || null,
    occurredAt,
    sourceRecordingUrl: null,
    rawPayload: message,
    handledById: message.userId || null,
    handledByName: await ghlApi.getUserName(message.userId).catch(() => null),
  });

  if (!inserted) return; // already processed this call

  try {
    const recording = await ghlApi.downloadRecording(message.id);
    const extension = recording.contentType.includes("wav") ? "wav" : "mp3";
    const taggedBuffer = embedMetadata(recording.buffer, extension, {
      occurredAt,
      direction: message.direction,
      durationSeconds: (message.meta && message.meta.call && message.meta.call.duration) || null,
      contactName: name,
      phone,
      timezone: await ghlApi.getAccountTimezone(),
    });
    const key = `${contactId}/${callRowId}.${extension}`;
    await saveRecording(key, taggedBuffer);
    await db.markCallStored(callRowId, key);
    console.log(`[poller] stored recording for call ${message.id}`);
  } catch (err) {
    console.error(`[poller] failed to fetch/store recording for call ${message.id}:`, err);
    await db.markCallFailed(callRowId);
  }
}

async function pollOnce() {
  if (!ghlApi.isConfigured()) return;

  let checkpoint = await db.getLastSyncedAt();
  if (!checkpoint) {
    // First ever run: start watching from now rather than walking the
    // account's entire call history.
    await db.setLastSyncedAt(new Date());
    return;
  }

  const conversations = await ghlApi.searchConversations(CONVERSATIONS_PER_POLL);
  const candidates = conversations.filter((c) => c.lastMessageDate > checkpoint.getTime());

  const newMessages = [];
  for (const conversation of candidates) {
    const messages = await ghlApi.listCallMessages(conversation.id);
    for (const message of messages) {
      if (new Date(message.dateAdded) > checkpoint) {
        newMessages.push({ conversation, message });
      }
    }
  }

  newMessages.sort((a, b) => new Date(a.message.dateAdded) - new Date(b.message.dateAdded));

  for (const { conversation, message } of newMessages) {
    try {
      await processCallMessage(conversation, message);
      checkpoint = new Date(message.dateAdded);
      await db.setLastSyncedAt(checkpoint);
    } catch (err) {
      console.error(`[poller] failed to process call ${message.id}, will retry next cycle:`, err);
      break; // stop this cycle; checkpoint stays before the failed message
    }
  }
}

function start() {
  if (!ghlApi.isConfigured()) {
    console.warn("[poller] GHL API not configured, call polling disabled");
    return;
  }
  console.log(`[poller] starting, polling every ${POLL_INTERVAL_MS / 1000}s`);
  pollOnce().catch((err) => console.error("[poller] initial poll failed:", err));
  setInterval(() => {
    pollOnce().catch((err) => console.error("[poller] poll cycle failed:", err));
  }, POLL_INTERVAL_MS);
}

module.exports = { start, pollOnce, processCallMessage };
