const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../db");
const { saveRecording } = require("../storage");
const ghlApi = require("../ghlApi");
const { embedMetadata } = require("../audioMetadata");

const router = express.Router();

// Fallback only for when the account's real timezone couldn't be looked up.
// See audioMetadata.js's copy of this same constant for why.
const DEFAULT_TIMEZONE = "America/Phoenix";

// GHL renders an unresolved merge tag as the literal text "null" (or
// "undefined") rather than omitting the key, so those must be treated the
// same as a genuinely missing value.
function isBlank(value) {
  return value === undefined || value === null || value === "" || value === "null" || value === "undefined";
}

function pick(obj, paths) {
  for (const p of paths) {
    const value = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (!isBlank(value)) return value;
  }
  return null;
}

// GHL sends some call timestamps as "YYYY-MM-DD HH:MM:SS" with no timezone
// indicator, in the sub-account's configured local time rather than UTC.
// Date() otherwise misinterprets that as UTC, silently shifting it by
// whatever the account's real offset is. Convert using the account's actual
// IANA timezone (not a fixed offset) so this is correct for any account and
// handles DST properly.
const NAIVE_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function zonedTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  // Treat the naive components as if they were UTC to get a reference
  // instant, then see what that instant renders as *in* the target
  // timezone -- the difference is exactly that zone's offset at that
  // moment (DST included), which corrects the reference into the real
  // UTC instant the original wall-clock time actually represents.
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(asIfUtc))
      .map((p) => [p.type, p.value])
  );
  const renderedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return new Date(asIfUtc + (asIfUtc - renderedAsUtc));
}

function parseDate(value, timeZone) {
  if (isBlank(value)) return null;
  const naive = NAIVE_LOCAL_DATE.exec(value);
  if (naive) {
    const [, year, month, day, hour, minute, second] = naive.map(Number);
    return zonedTimeToUtc(year, month, day, hour, minute, second, timeZone || DEFAULT_TIMEZONE);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// GHL's exact field names vary by trigger/version, so we check several
// known variants. Log the raw payload regardless so real field names can
// be confirmed against a live "Call Completed" webhook during setup.
function normalizePayload(body, timezone) {
  const contactId = pick(body, ["contact_id", "contactId", "contact.id"]);
  const name = pick(body, [
    "contact_name",
    "full_name",
    "contact.name",
    "contact.full_name",
  ]) || [pick(body, ["first_name", "contact.first_name"]), pick(body, ["last_name", "contact.last_name"])]
    .filter(Boolean)
    .join(" ") || null;
  const phone = pick(body, ["phone", "contact.phone", "message.phone", "phoneCall.phone"]);
  // GHL's merge-field picker confirmed the namespace is phoneCall.* for this
  // trigger (e.g. phoneCall.duration) -- not call.* or message.* as guessed
  // earlier. Keep the old variants too in case they're used elsewhere.
  const callId = pick(body, [
    "call_id",
    "callId",
    "id",
    "message_id",
    "messageId",
    "message.id",
    "phoneCall.id",
    "phoneCall.callId",
  ]);
  const direction = pick(body, [
    "direction",
    "call_direction",
    "callDirection",
    "message.direction",
    "phoneCall.direction",
  ]);
  const duration = pick(body, [
    "duration",
    "call_duration",
    "durationInSeconds",
    "callDuration",
    "message.duration",
    "phoneCall.duration",
  ]);
  const recordingUrl = pick(body, [
    "recording_url",
    "recordingUrl",
    "call_recording_url",
    "message.recording_url",
    "message.recordingUrl",
    "message.attachments.0",
    "attachments.0",
    "phoneCall.recordingUrl",
    "phoneCall.recording_url",
    "phoneCall.attachments.0",
  ]);
  const occurredAt = pick(body, [
    // GHL substitutes merge-tag values into whatever flat JSON key names the
    // webhook body uses -- it doesn't nest by the tag's own dotted name -- so
    // match flat key names, not "phoneCall.startTime" style paths.
    "start_time",
    "startTime",
    "end_time",
    "endTime",
    "timestamp",
    "date_added",
    "dateAdded",
    "call_date",
    "callDate",
  ]);
  // Which GHL user (agent) handled this call -- used for per-user access
  // control (admins see everything, users see only calls with a matching
  // handled_by_id). The recommended webhook body names these user_id/user_name.
  const handledById = pick(body, ["user_id", "userId", "handled_by_id"]);
  const handledByName = pick(body, ["user_name", "userName", "handled_by_name"]);

  const resolvedContactId = contactId ? String(contactId) : null;
  const resolvedOccurredAt = parseDate(occurredAt, timezone);

  // GHL's "Call Completed" trigger has no dedicated call ID merge field.
  // Derive a stable one from contact + call time instead, so retries of the
  // same webhook delivery still dedupe (GHL resends the same timestamp).
  const resolvedCallId = callId
    ? String(callId)
    : resolvedContactId
      ? `${resolvedContactId}-${resolvedOccurredAt ? resolvedOccurredAt.getTime() : Date.now()}`
      : null;

  return {
    contactId: resolvedContactId,
    name,
    phone,
    callId: resolvedCallId,
    direction,
    durationSeconds: !isBlank(duration) ? parseInt(duration, 10) : null,
    recordingUrl: !isBlank(recordingUrl) ? recordingUrl : null,
    occurredAt: resolvedOccurredAt,
    handledById: !isBlank(handledById) ? String(handledById) : null,
    handledByName: !isBlank(handledByName) ? handledByName : null,
  };
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop();
    if (ext && ext.length <= 5 && /^[a-zA-Z0-9]+$/.test(ext)) return ext;
  } catch {
    // fall through to default
  }
  return "mp3";
}

router.post("/ghl/call-completed", express.json({ limit: "2mb" }), async (req, res) => {
  if (process.env.WEBHOOK_TOKEN && req.query.token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "invalid or missing token" });
  }

  console.log("[webhook] received payload:", JSON.stringify(req.body));

  try {
    const timezone = (await ghlApi.getAccountTimezone()) || DEFAULT_TIMEZONE;
    const parsed = normalizePayload(req.body, timezone);

    if (!parsed.contactId || !parsed.callId) {
      console.warn("[webhook] missing contactId/callId, check field names against raw payload above");
      return res.status(400).json({
        error: "could not find contactId/callId in payload; see server logs for the raw payload",
      });
    }

    await db.upsertContact({
      contactId: parsed.contactId,
      name: parsed.name,
      phone: parsed.phone,
    });

    const callRowId = randomUUID();
    const inserted = await db.insertCall({
      id: callRowId,
      ghlCallId: parsed.callId,
      contactId: parsed.contactId,
      direction: parsed.direction,
      durationSeconds: parsed.durationSeconds,
      occurredAt: parsed.occurredAt,
      sourceRecordingUrl: parsed.recordingUrl,
      rawPayload: req.body,
      handledById: parsed.handledById,
      handledByName: parsed.handledByName,
    });

    if (!inserted) {
      return res.status(200).json({ status: "duplicate", ghlCallId: parsed.callId });
    }

    if (!parsed.recordingUrl && !ghlApi.isConfigured()) {
      console.warn(`[webhook] no recording URL for call ${parsed.callId}, metadata stored without audio`);
      return res.status(200).json({ status: "stored_without_recording", callId: callRowId });
    }

    try {
      let buffer;
      let extension = "mp3";

      if (parsed.recordingUrl) {
        const response = await fetch(parsed.recordingUrl);
        if (!response.ok) throw new Error(`fetch failed with status ${response.status}`);
        buffer = Buffer.from(await response.arrayBuffer());
        extension = extensionFromUrl(parsed.recordingUrl);
      } else {
        // The Call Completed trigger has no recording-URL merge field at all
        // (confirmed against GHL's docs), so look it up via GHL's own API
        // using the contact + call time we do have.
        const recording = await ghlApi.findCallRecording({
          contactId: parsed.contactId,
          occurredAt: parsed.occurredAt,
        });
        if (!recording) {
          console.warn(`[webhook] could not locate recording via GHL API for call ${parsed.callId}`);
          return res.status(200).json({ status: "stored_without_recording", callId: callRowId });
        }
        buffer = recording.buffer;
        extension = recording.contentType.includes("wav") ? "wav" : "mp3";
      }

      const taggedBuffer = embedMetadata(buffer, extension, {
        occurredAt: parsed.occurredAt,
        direction: parsed.direction,
        durationSeconds: parsed.durationSeconds,
        contactName: parsed.name,
        phone: parsed.phone,
        timezone,
      });

      const key = `${parsed.contactId}/${callRowId}.${extension}`;
      await saveRecording(key, taggedBuffer);
      await db.markCallStored(callRowId, key);
      return res.status(200).json({ status: "ok", callId: callRowId });
    } catch (err) {
      console.error(`[webhook] failed to fetch/store recording for call ${parsed.callId}:`, err);
      await db.markCallFailed(callRowId);
      return res.status(202).json({ status: "metadata_saved_recording_fetch_failed", callId: callRowId });
    }
  } catch (err) {
    console.error("[webhook] unexpected error handling payload:", err);
    return res.status(500).json({ error: "internal error processing webhook, see server logs" });
  }
});

module.exports = router;
