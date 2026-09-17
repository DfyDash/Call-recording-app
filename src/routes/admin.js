const express = require("express");
const { randomUUID } = require("crypto");
const archiver = require("archiver");
const db = require("../db");
const ghlApi = require("../ghlApi");
const { getBuffer } = require("../storage");
const { hashPassword, requireAdmin, requireCsrf } = require("../auth");
const { loginLimiter, limiterKey } = require("./auth");

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

router.post("/users", requireCsrf, async (req, res) => {
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

router.put("/users/:id", requireCsrf, async (req, res) => {
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

  // A reset should actually unlock them, not leave them waiting out the
  // login rate limit's window under their old, now-wrong password.
  if (password && target) {
    await loginLimiter.resetKey(limiterKey(target.username));
  }

  const who = target ? target.username : req.params.id;
  const changes = [];
  if (role !== undefined) changes.push(`role → ${role}`);
  if (ghlUserId !== undefined) changes.push(`GHL user → ${ghlUserName || ghlUserId || "(none)"}`);
  if (password) changes.push("password reset");
  if (changes.length) await log(req, "user_updated", `Updated user "${who}": ${changes.join(", ")}`);

  res.json({ status: "updated" });
});

router.delete("/users/:id", requireCsrf, async (req, res) => {
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

router.put("/settings", requireCsrf, async (req, res) => {
  const enabled = Boolean((req.body || {}).autoTranscribeEnabled);
  await db.setAutoTranscribeEnabled(enabled);
  await log(req, "auto_transcribe_toggled", `Turned automatic transcription ${enabled ? "ON" : "OFF"}`);
  res.json({ autoTranscribeEnabled: enabled });
});

router.get("/audit-log", async (req, res) => {
  const result = await db.listAuditLog({ page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
});

// PHI-access log (who accessed which call's recording/transcript, when,
// success or denied) -- see routes/api.js. HIPAA's audit-controls rule
// expects this reviewed regularly, not just recorded, hence a real view
// rather than just rows sitting in the database.
router.get("/phi-access-log", async (req, res) => {
  const result = await db.listPhiAccessLog({ page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
});

// Bulk export -- everyone's recordings (optionally date-filtered) as one
// streamed ZIP, not one-by-one. The main use case is getting a full copy
// of everything before an account is canceled and its storage purged (see
// the account-cancellation flow), but it's useful any time an admin wants
// an offline copy. Streams straight to the response as each file is read
// (archiver + one getBuffer() at a time) rather than buffering the whole
// export in memory or on disk first.
router.get("/download-all", async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const calls = await db.listAllCallsWithRecordings({ dateFrom, dateTo });

  await log(
    req,
    "bulk_export",
    `Started bulk export of ${calls.length} call recording${calls.length === 1 ? "" : "s"}` +
      (dateFrom || dateTo ? ` (${dateFrom || "…"} to ${dateTo || "…"})` : "")
  );

  const zipName = `calltrove-export-${new Date().toISOString().slice(0, 10)}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  // Low compression, not zero: WAV (uncompressed PCM) still shrinks
  // meaningfully, but burning CPU trying to compress already-compressed
  // MP3s further isn't worth it on a small instance during a big export.
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.on("error", (err) => {
    console.error("[admin] zip export failed:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  for (const call of calls) {
    let buffer;
    try {
      buffer = await getBuffer(call.storageKey);
    } catch (err) {
      console.error(`[admin] skipping call ${call.id} in export, couldn't read recording:`, err);
      continue;
    }
    if (!buffer) continue;

    // call.id.slice(0, 8) makes the filename unique on its own (a UUID
    // collision in the first 8 hex chars is astronomically unlikely), no
    // separate collision-tracking needed.
    const ext = call.storageKey.split(".").pop();
    const who = (call.contactName || call.contactPhone || "unknown").replace(/[^a-zA-Z0-9]+/g, "_");
    const date = call.occurredAt ? new Date(call.occurredAt).toISOString().slice(0, 10) : "unknown-date";
    const name = `${who}/${date}_${call.direction || "call"}_${call.id.slice(0, 8)}.${ext}`;

    archive.append(buffer, { name });
  }

  await archive.finalize();
});

module.exports = router;
