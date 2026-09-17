const express = require("express");
const db = require("../db");
const { getPlayback } = require("../storage");

const router = express.Router();

// Admins see everything; regular users are scoped to calls they handled.
// Returning undefined (no filter) for admins, vs. their GHL user id
// otherwise, is the single enforcement point every route below relies on.
function ownerFilter(req) {
  return req.session.user.role === "admin" ? undefined : req.session.user.ghlUserId;
}

router.get("/me", (req, res) => {
  const { username, role, ghlUserId } = req.session.user;
  res.json({ username, role, ghlUserId });
});

router.get("/contacts", async (req, res) => {
  const contacts = await db.listContacts(req.query.search, ownerFilter(req));
  res.json(contacts);
});

router.get("/contacts/:id/calls", async (req, res) => {
  const calls = await db.listCallsForContact(req.params.id, ownerFilter(req));
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
  const owner = ownerFilter(req);
  if (owner && call.handledById !== owner) {
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

module.exports = router;
