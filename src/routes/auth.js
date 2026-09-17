const express = require("express");
const db = require("../db");
const { verifyPassword, hashPassword, sessionUser } = require("../auth");

const router = express.Router();

router.post("/login", express.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const user = username && password ? await db.getUserByUsername(username) : null;
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.redirect("/login.html?error=1");
  }
  req.session.user = sessionUser(user);
  res.redirect("/");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login.html"));
});

// Self-service change for a logged-in user -- distinct from an admin
// resetting someone else's password (that's in routes/admin.js), and
// requires knowing the current password, unlike that admin path.
router.post("/change-password", express.urlencoded({ extended: false }), async (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");

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
