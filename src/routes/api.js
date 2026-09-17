const express = require("express");
const db = require("../db");
const { getPlayback } = require("../storage");

const router = express.Router();

router.get("/contacts", async (req, res) => {
  const contacts = await db.listContacts(req.query.search);
  res.json(contacts);
});

router.get("/contacts/:id/calls", async (req, res) => {
  const calls = await db.listCallsForContact(req.params.id);
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
