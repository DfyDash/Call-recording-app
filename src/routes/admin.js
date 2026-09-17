const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../db");
const ghlApi = require("../ghlApi");
const { hashPassword, requireAdmin } = require("../auth");

const router = express.Router();

router.use(requireAdmin);

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
  res.status(201).json({ status: "created" });
});

router.put("/users/:id", async (req, res) => {
  const { role, ghlUserId, ghlUserName, password } = req.body || {};
  if (role !== undefined && !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "invalid role" });
  }
  const update = { role, ghlUserId, ghlUserName };
  if (password) {
    const { hash, salt } = hashPassword(password);
    update.passwordHash = hash;
    update.passwordSalt = salt;
  }
  await db.updateUser(req.params.id, update);
  res.json({ status: "updated" });
});

router.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.session.user.id) {
    return res.status(400).json({ error: "cannot delete your own account while logged in as it" });
  }
  await db.deleteUser(req.params.id);
  res.json({ status: "deleted" });
});

module.exports = router;
