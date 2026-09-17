const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../db");
const { saveRecording } = require("../storage");

const router = express.Router();

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

function parseDate(value) {
  if (isBlank(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// GHL's exact field names vary by trigger/version, so we check several
// known variants. Log the raw payload regardless so real field names can
// be confirmed against a live "Call Completed" webhook during setup.
function normalizePayload(body) {
  const contactId = pick(body, ["contact_id", "contactId", "contact.id"]);
  const name = pick(body, [
    "contact_name",
    "full_name",
    "contact.name",
    "contact.full_name",
  ]) || [pick(body, ["first_name", "contact.first_name"]), pick(body, ["last_name", "contact.last_name"])]
    .filter(Boolean)
    .join(" ") || null;
  const phone = pick(body, ["phone", "contact.phone"]);
  const callId = pick(body, ["call_id", "callId", "id", "message_id", "messageId"]);
  const direction = pick(body, ["direction", "call_direction", "callDirection"]);
  const duration = pick(body, ["duration", "call_duration", "durationInSeconds", "callDuration"]);
  const recordingUrl = pick(body, [
    "recording_url",
    "recordingUrl",
    "call_recording_url",
    "attachments.0",
  ]);
  const occurredAt = pick(body, [
    "timestamp",
    "date_added",
    "dateAdded",
    "call_date",
    "callDate",
  ]);

  return {
    contactId: contactId ? String(contactId) : null,
    name,
    phone,
    callId: callId ? String(callId) : null,
    direction,
    durationSeconds: !isBlank(duration) ? parseInt(duration, 10) : null,
    recordingUrl: !isBlank(recordingUrl) ? recordingUrl : null,
    occurredAt: parseDate(occurredAt),
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
    const parsed = normalizePayload(req.body);

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
    });

    if (!inserted) {
      return res.status(200).json({ status: "duplicate", ghlCallId: parsed.callId });
    }

    if (!parsed.recordingUrl) {
      console.warn(`[webhook] no recording URL for call ${parsed.callId}, metadata stored without audio`);
      return res.status(200).json({ status: "stored_without_recording", callId: callRowId });
    }

    try {
      const response = await fetch(parsed.recordingUrl);
      if (!response.ok) throw new Error(`fetch failed with status ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const key = `${parsed.contactId}/${callRowId}.${extensionFromUrl(parsed.recordingUrl)}`;
      await saveRecording(key, buffer);
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
