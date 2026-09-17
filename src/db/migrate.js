require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  await pool.end();
  console.log("Schema applied.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
