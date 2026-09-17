const express = require("express");
const { randomBytes } = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { verifyPassword, hashPassword, sessionUser } = require("../auth");

const router = express.Router();

// Scoped to the login route specifically -- this is the actual
// brute-force target, not the rest of the app. Keyed by IP (the default),
// so it won't lock out other users sharing an office/VPN egress on its own
// -- 20 attempts per 15 minutes is generous for a real user, tight for a
// password-guessing script.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// req.body.csrfToken is a hidden form field on the two classic HTML-form
// POSTs below (logout, change-password) -- they aren't fetch calls, so
// they can't set the X-CSRF-Token header the JSON API routes use instead
// (see auth.js's requireCsrf). Only enforced when there's an actual
// session to protect; an unauthenticated logout has nothing worth forging.
function csrfValid(req) {
  return Boolean(req.session.csrfToken) && req.body.csrfToken === req.session.csrfToken;
}

router.post("/login", loginLimiter, express.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const user = username && password ? await db.getUserByUsername(username) : null;
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.redirect("/login.html?error=1");
  }
  req.session.user = sessionUser(user);
  req.session.csrfToken = randomBytes(24).toString("hex");
  res.redirect("/");
});

router.post("/logout", express.urlencoded({ extended: false }), (req, res) => {
  if (req.session.user && !csrfValid(req)) {
    return res.redirect("/login.html?error=1");
  }
  req.session.destroy(() => res.redirect("/login.html"));
});

// Self-service change for a logged-in user -- distinct from an admin
// resetting someone else's password (that's in routes/admin.js), and
// requires knowing the current password, unlike that admin path.
router.post("/change-password", express.urlencoded({ extended: false }), async (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");
  if (!csrfValid(req)) return res.redirect("/account.html?error=csrf");

  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword !== confirmPassword) {
    return res.redirect("/account.html?error=mismatch");
  }
  if (newPassword.length < 8) {
    return res.redirect("/account.html?error=tooshort");
  }

  const user = await db.getUserByUsername(req.session.user.username);
  if (!user || !verifyPassword(currentPassword, user.passwordHash, user.passwordSalt)) {
    return res.redirect("/account.html?error=wrongcurrent");
  }

  const { hash, salt } = hashPassword(newPassword);
  await db.updateUser(user.id, { passwordHash: hash, passwordSalt: salt });
  res.redirect("/account.html?success=1");
});

module.exports = router;
