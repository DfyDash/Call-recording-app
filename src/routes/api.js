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

router.get("/calls/:id/recording", async (req, res) => {
  const call = await db.getCall(req.params.id);
  if (!call || !call.storageKey) {
    return res.status(404).json({ error: "recording not found" });
  }
  const playback = await getPlayback(call.storageKey);
  if (playback.redirectUrl) {
    return res.redirect(playback.redirectUrl);
  }
  if (playback.stream) {
    return playback.stream.pipe(res);
  }
  return res.status(404).json({ error: "recording not found" });
});

module.exports = router;
