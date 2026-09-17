require("dotenv").config();
const path = require("path");
const express = require("express");

const webhookRouter = require("./routes/webhook");
const apiRouter = require("./routes/api");

const app = express();

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/webhooks", webhookRouter);
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Call Recording Vault listening on port ${port}`);
});
