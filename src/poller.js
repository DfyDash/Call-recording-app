const { randomUUID } = require("crypto");
const db = require("./db");
const ghlApi = require("./ghlApi");
const { saveRecording } = require("./storage");
const { embedMetadata } = require("./audioMetadata");
const transcription = require("./transcription");

const POLL_INTERVAL_MS = 60 * 1000;
const CONVERSATIONS_PER_POLL = 100;

// GHL sometimes hasn't finished processing a call's recording -- or even
// settled its final duration -- at the moment the poller first sees the
// message (confirmed: a message caught seconds after the call started can
// read status "ringing" with duration null; the same message returns a
// real recording minutes later). A one-shot lookup right after the call
// permanently mislabels those as having no recording at all. So a call
// marked 'failed' gets one more look on every poll cycle for this long
// before being treated as genuinely missing, the way an old backfilled
// call is.
const FAILED_RECORDING_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Replaces the GHL "Call Completed" workflow/webhook entirely: scans for
// new call messages via GHL's own Conversations API on a timer instead of
// waiting for GHL to push one. This is more reliable than the webhook was
// (real message IDs instead of a synthetic fallback, proper ISO timestamps
// instead of GHL's ambiguous timezone-less strings, handled-by/duration/
// direction straight from the API instead of depending on a hand-built
// webhook JSON body) and needs zero manual setup in GHL per account.
//
// checkAutoTranscribe defaults off -- src/backfill.js relies on that default
// so historical calls are never swept into auto-transcription no matter what
// the app_settings toggle is set to. pollOnce() below, the live
// forward-watching path, is the only caller that passes it true: the
// auto_transcribe_enabled setting is read fresh per call here, so flipping
// it in the admin UI affects only calls the live poller picks up from that
// point on, never anything already in the database.
async function processCallMessage(conversation, message, { checkAutoTranscribe = false } = {}) {
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

    if (checkAutoTranscribe && transcription.isEnabled() && (await db.getAutoTranscribeEnabled())) {
      try {
        await transcription.startJob(callRowId, taggedBuffer, extension);
        await db.markTranscriptionPending(callRowId);
      } catch (err) {
        console.error(`[poller] failed to start auto-transcription for call ${message.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[poller] failed to fetch/store recording for call ${message.id}:`, err);
    await db.markCallFailed(callRowId);
  }
}

// Re-attempts calls the live poller marked 'failed' recently, in case GHL
// has since finished processing the recording (see the constant above for
// why this exists). Never touches calls backfill.js inserted -- those are
// old enough that "still processing" isn't a plausible explanation, so a
// 'failed' there really does mean GHL has no recording for it.
async function retryFailedRecordings(maxAgeMs = FAILED_RECORDING_RETRY_WINDOW_MS) {
  const candidates = await db.listRetryableFailedCalls(maxAgeMs);

  for (const call of candidates) {
    const conversationId = call.rawPayload && call.rawPayload.conversationId;
    if (!conversationId) continue;

    let messages;
    try {
      messages = await ghlApi.listCallMessages(conversationId);
    } catch (err) {
      console.error(`[poller] retry: failed to list messages for call ${call.ghlCallId}:`, err);
      continue;
    }
    const message = messages.find((m) => m.id === call.ghlCallId);
    if (!message) continue;

    const status = message.meta && message.meta.call && message.meta.call.status;
    if (status === "ringing") continue; // call not actually finished yet, try again next cycle

    try {
      const recording = await ghlApi.downloadRecording(call.ghlCallId);
      const extension = recording.contentType.includes("wav") ? "wav" : "mp3";
      const durationSeconds = (message.meta && message.meta.call && message.meta.call.duration) || null;
      const taggedBuffer = embedMetadata(recording.buffer, extension, {
        occurredAt: call.occurredAt,
        direction: call.direction,
        durationSeconds,
        contactName: call.contactName,
        phone: call.contactPhone,
        timezone: await ghlApi.getAccountTimezone(),
      });
      const key = `${call.contactId}/${call.id}.${extension}`;
      await saveRecording(key, taggedBuffer);
      await db.markCallStored(call.id, key, durationSeconds);
      console.log(`[poller] retry succeeded for call ${call.ghlCallId} (recording was still processing)`);
    } catch (err) {
      // Still not ready, or genuinely never going to have one -- leave it
      // 'failed'; either the next cycle catches it or the retry window
      // above eventually lets it settle as a real miss.
    }
  }
}

async function pollOnce() {
  if (!ghlApi.isConfigured()) return;

  await retryFailedRecordings();

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
      await processCallMessage(conversation, message, { checkAutoTranscribe: true });
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

module.exports = { start, pollOnce, processCallMessage, retryFailedRecordings };
