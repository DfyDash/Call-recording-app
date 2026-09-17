require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const apiRouter = require("./routes/api");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");
const { requireAuth } = require("./auth");
const poller = require("./poller");
const transcriptionPoller = require("./transcriptionPoller");

const app = express();

app.set("trust proxy", 1); // behind nginx, which terminates TLS

app.get("/health", (req, res) => res.json({ ok: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 },
  })
);

// Unauthenticated: the login page itself and what it needs to render.
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "style.css")));
app.use("/auth", authRouter);

app.use(requireAuth);
app.use(express.json());
app.use("/api/admin", adminRouter);
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CallTrove listening on port ${port}`);
});

// Call ingestion now happens by polling GHL's own API rather than a GHL
// workflow/webhook -- see src/poller.js for why.
poller.start();
transcriptionPoller.start();
