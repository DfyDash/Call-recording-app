const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

// Session payload is the full set of fields access-control checks need, so
// routes never have to hit the DB just to find out who's asking.
function sessionUser(user) {
  return { id: user.id, username: user.username, role: user.role, ghlUserId: user.ghlUserId };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not logged in" });
    return res.redirect("/login.html");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "admin access required" });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, sessionUser, requireAuth, requireAdmin };
