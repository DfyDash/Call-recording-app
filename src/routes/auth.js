const express = require("express");
const db = require("../db");
const { verifyPassword, sessionUser } = require("../auth");

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

module.exports = router;
