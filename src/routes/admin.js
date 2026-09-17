const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../db");
const ghlApi = require("../ghlApi");
const { hashPassword, requireAdmin } = require("../auth");

const router = express.Router();

router.use(requireAdmin);

function log(req, action, message) {
  return db.logAudit({ actorId: req.session.user.id, actorUsername: req.session.user.username, action, message });
}

router.get("/users", async (req, res) => {
  const users = await db.listUsers();
  res.json(users);
});

// The real GHL user list, for populating a picker in the admin UI instead
// of requiring someone to hand-type a phoneCall.user.id value.
router.get("/ghl-users", async (req, res) => {
  if (!ghlApi.isConfigured()) return res.json([]);
  try {
    const users = await ghlApi.listUsers();
    res.json(users);
  } catch (err) {
    console.error("[admin] failed to fetch GHL users:", err);
    res.status(502).json({ error: "could not fetch GHL user list" });
  }
});

router.post("/users", async (req, res) => {
  const { username, password, role, ghlUserId, ghlUserName } = req.body || {};
  if (!username || !password || !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "username, password, and a valid role are required" });
  }
  const existing = await db.getUserByUsername(username);
  if (existing) return res.status(409).json({ error: "username already taken" });

  const { hash, salt } = hashPassword(password);
  await db.createUser({
    id: randomUUID(),
    username,
    passwordHash: hash,
    passwordSalt: salt,
    role,
    ghlUserId,
    ghlUserName,
  });
  await log(req, "user_created", `Created user "${username}" (role: ${role})`);
  res.status(201).json({ status: "created" });
});

router.put("/users/:id", async (req, res) => {
  const { role, ghlUserId, ghlUserName, password } = req.body || {};
  if (role !== undefined && !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "invalid role" });
  }
  const target = await db.getUserById(req.params.id);
  const update = { role, ghlUserId, ghlUserName };
  if (password) {
    const { hash, salt } = hashPassword(password);
    update.passwordHash = hash;
    update.passwordSalt = salt;
  }
  await db.updateUser(req.params.id, update);

  const who = target ? target.username : req.params.id;
  const changes = [];
  if (role !== undefined) changes.push(`role → ${role}`);
  if (ghlUserId !== undefined) changes.push(`GHL user → ${ghlUserName || ghlUserId || "(none)"}`);
  if (password) changes.push("password reset");
  if (changes.length) await log(req, "user_updated", `Updated user "${who}": ${changes.join(", ")}`);

  res.json({ status: "updated" });
});

router.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.session.user.id) {
    return res.status(400).json({ error: "cannot delete your own account while logged in as it" });
  }
  const target = await db.getUserById(req.params.id);
  await db.deleteUser(req.params.id);
  await log(req, "user_deleted", `Deleted user "${target ? target.username : req.params.id}"`);
  res.json({ status: "deleted" });
});

// Live, admin-toggleable, no redeploy needed. Only affects calls the live
// poller picks up after this is read (see poller.js) -- never retroactive.
router.get("/settings", async (req, res) => {
  res.json({ autoTranscribeEnabled: await db.getAutoTranscribeEnabled() });
});

router.put("/settings", async (req, res) => {
  const enabled = Boolean((req.body || {}).autoTranscribeEnabled);
  await db.setAutoTranscribeEnabled(enabled);
  await log(req, "auto_transcribe_toggled", `Turned automatic transcription ${enabled ? "ON" : "OFF"}`);
  res.json({ autoTranscribeEnabled: enabled });
});

router.get("/audit-log", async (req, res) => {
  const result = await db.listAuditLog({ page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
});

module.exports = router;
