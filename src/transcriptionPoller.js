const db = require("./db");
const transcription = require("./transcription");

// AWS Transcribe jobs are async (typically finish well within a couple
// minutes for a call-length recording), so this checks in on outstanding
// jobs rather than blocking the main call poller on them.
const POLL_INTERVAL_MS = 30 * 1000;

async function pollOnce() {
  if (!transcription.isEnabled()) return;

  const pending = await db.listPendingTranscriptions();
  for (const call of pending) {
    try {
      const result = await transcription.checkJob(call.id);
      if (result.status === "completed") {
        await db.markTranscriptionComplete(call.id, result.text);
        console.log(`[transcription] completed for call ${call.id}`);
      } else if (result.status === "failed") {
        await db.markTranscriptionFailed(call.id);
        console.error(`[transcription] failed for call ${call.id}: ${result.reason}`);
      }
      // still pending: leave it, checked again next cycle
    } catch (err) {
      console.error(`[transcription] error checking job for call ${call.id}:`, err);
    }
  }
}

function start() {
  if (!transcription.isEnabled()) {
    console.warn("[transcription] disabled (set TRANSCRIPTION_ENABLED=true plus S3_BUCKET/S3_REGION to enable)");
    return;
  }
  console.log(`[transcription] starting, checking every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(() => {
    pollOnce().catch((err) => console.error("[transcription] poll cycle failed:", err));
  }, POLL_INTERVAL_MS);
}

module.exports = { start, pollOnce };
