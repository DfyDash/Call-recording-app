const express = require("express");
const db = require("../db");
const { getPlayback } = require("../storage");

const router = express.Router();

// Regular users are always scoped to calls they handled -- this is the real
// security boundary and never changes based on request input. Admins see
// everything by default, but can optionally narrow the *list views* to a
// specific GHL user via ?viewAs= for monitoring/spot-checking one agent;
// that's a convenience filter, not a restriction on the admin's own access.
function listFilter(req) {
  if (req.session.user.role === "admin") return req.query.viewAs || undefined;
  return req.session.user.ghlUserId;
}

router.get("/me", (req, res) => {
  const { username, role, ghlUserId } = req.session.user;
  res.json({ username, role, ghlUserId });
});

router.get("/contacts", async (req, res) => {
  const contacts = await db.listContacts(req.query.search, listFilter(req));
  res.json(contacts);
});

router.get("/contacts/:id/calls", async (req, res) => {
  const calls = await db.listCallsForContact(req.params.id, listFilter(req));
  res.json(calls);
});

function buildDownloadFilename(call) {
  const ext = call.storageKey.split(".").pop();
  const who = (call.name || call.phone || call.contactId || "call").replace(/[^a-zA-Z0-9]+/g, "_");
  const date = call.occurredAt ? new Date(call.occurredAt).toISOString().slice(0, 10) : "unknown-date";
  return `${who}_${date}_${call.direction || "call"}.${ext}`;
}

router.get("/calls/:id/recording", async (req, res) => {
  const call = await db.getCall(req.params.id);
  if (!call || !call.storageKey) {
    return res.status(404).json({ error: "recording not found" });
  }

  // Enforced here too, not just in the list views -- a user must not be
  // able to fetch another user's recording just by knowing/guessing its URL.
  // Admins always have access regardless of any ?viewAs= list filter.
  if (req.session.user.role !== "admin" && call.handledById !== req.session.user.ghlUserId) {
    return res.status(403).json({ error: "not your call" });
  }

  const download = req.query.download !== undefined;
  const filename = download ? buildDownloadFilename(call) : undefined;

  const playback = await getPlayback(call.storageKey, filename);
  if (playback.redirectUrl) {
    return res.redirect(playback.redirectUrl);
  }
  if (playback.stream) {
    if (filename) {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }
    return playback.stream.pipe(res);
  }
  return res.status(404).json({ error: "recording not found" });
});

router.get("/calls/:id/transcript", async (req, res) => {
  const call = await db.getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "call not found" });

  // Same access boundary as the recording itself.
  if (req.session.user.role !== "admin" && call.handledById !== req.session.user.ghlUserId) {
    return res.status(403).json({ error: "not your call" });
  }

  res.json({ status: call.transcriptionStatus, transcript: call.transcript });
});

module.exports = router;
