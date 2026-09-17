const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
});

async function upsertContact({ contactId, name, phone }) {
  await pool.query(
    `INSERT INTO contacts (ghl_contact_id, name, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (ghl_contact_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, contacts.name),
       phone = COALESCE(EXCLUDED.phone, contacts.phone),
       updated_at = now()`,
    [contactId, name || null, phone || null]
  );
}

async function insertCall({
  id,
  ghlCallId,
  contactId,
  direction,
  durationSeconds,
  occurredAt,
  sourceRecordingUrl,
  rawPayload,
  handledById,
  handledByName,
}) {
  const result = await pool.query(
    `INSERT INTO calls (
       id, ghl_call_id, ghl_contact_id, direction, duration_seconds,
       occurred_at, source_recording_url, recording_status, raw_payload,
       handled_by_id, handled_by_name
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
     ON CONFLICT (ghl_call_id) DO NOTHING
     RETURNING id`,
    [
      id,
      ghlCallId,
      contactId,
      direction || null,
      durationSeconds || null,
      occurredAt || null,
      sourceRecordingUrl || null,
      rawPayload || null,
      handledById || null,
      handledByName || null,
    ]
  );
  return result.rows[0] || null;
}

async function markCallStored(callId, storageKey) {
  await pool.query(
    `UPDATE calls SET storage_key = $2, recording_status = 'stored' WHERE id = $1`,
    [callId, storageKey]
  );
}

async function markCallFailed(callId) {
  await pool.query(
    `UPDATE calls SET recording_status = 'failed' WHERE id = $1`,
    [callId]
  );
}

// GHL's Messages API reliably includes who handled a call (unlike the
// webhook payload, which depends on the workflow body being configured
// right), so it's applied as a correction after the initial insert once
// the recording lookup returns it.
async function updateCallHandler(callId, handledById, handledByName) {
  if (!handledById) return;
  await pool.query(
    `UPDATE calls SET handled_by_id = $2, handled_by_name = $3 WHERE id = $1`,
    [callId, handledById, handledByName || null]
  );
}

// ghlUserId, when given, scopes results to contacts/calls that user
// actually handled -- the enforcement point for "users see only their own
// calls, admins see everything" (ghlUserId omitted/null means admin/no
// restriction).
async function listContacts(search, ghlUserId) {
  const conditions = [];
  const params = [];
  if (ghlUserId) {
    params.push(ghlUserId);
    conditions.push(`EXISTS (SELECT 1 FROM calls c WHERE c.ghl_contact_id = contacts.ghl_contact_id AND c.handled_by_id = $${params.length})`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT ghl_contact_id AS id, name, phone
     FROM contacts
     ${where}
     ORDER BY ${search ? "name NULLS LAST" : "updated_at DESC"}
     LIMIT 50`,
    params
  );
  return rows;
}

async function listCallsForContact(contactId, ghlUserId) {
  const params = [contactId];
  let condition = "";
  if (ghlUserId) {
    params.push(ghlUserId);
    condition = `AND handled_by_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT id, direction, duration_seconds AS "durationSeconds",
            occurred_at AS "occurredAt", recording_status AS "recordingStatus",
            storage_key IS NOT NULL AS "hasRecording", handled_by_name AS "handledByName"
     FROM calls
     WHERE ghl_contact_id = $1 ${condition}
     ORDER BY occurred_at DESC NULLS LAST, created_at DESC`,
    params
  );
  return rows;
}

async function getCall(callId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.storage_key AS "storageKey", c.recording_status AS "recordingStatus",
            c.occurred_at AS "occurredAt", c.direction, c.ghl_contact_id AS "contactId",
            c.handled_by_id AS "handledById", ct.name, ct.phone
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.id = $1`,
    [callId]
  );
  return rows[0] || null;
}

// --- users (dashboard login accounts) ---

async function createUser({ id, username, passwordHash, passwordSalt, role, ghlUserId, ghlUserName }) {
  await pool.query(
    `INSERT INTO users (id, username, password_hash, password_salt, role, ghl_user_id, ghl_user_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, username, passwordHash, passwordSalt, role, ghlUserId || null, ghlUserName || null]
  );
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash", password_salt AS "passwordSalt",
            role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName"
     FROM users WHERE username = $1`,
    [username]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName"
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT id, username, role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", created_at AS "createdAt"
     FROM users ORDER BY created_at ASC`
  );
  return rows;
}

async function updateUser(id, { role, ghlUserId, ghlUserName, passwordHash, passwordSalt }) {
  const sets = [];
  const params = [];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (role !== undefined) add("role", role);
  if (ghlUserId !== undefined) add("ghl_user_id", ghlUserId || null);
  if (ghlUserName !== undefined) add("ghl_user_name", ghlUserName || null);
  if (passwordHash !== undefined) add("password_hash", passwordHash);
  if (passwordSalt !== undefined) add("password_salt", passwordSalt);
  if (sets.length === 0) return;
  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

async function deleteUser(id) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
}

// --- sync_state (poller checkpoint) ---

async function getLastSyncedAt() {
  const { rows } = await pool.query(`SELECT last_synced_at AS "lastSyncedAt" FROM sync_state WHERE id = 1`);
  return rows[0] ? rows[0].lastSyncedAt : null;
}

async function setLastSyncedAt(date) {
  await pool.query(
    `INSERT INTO sync_state (id, last_synced_at) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
    [date]
  );
}

module.exports = {
  pool,
  upsertContact,
  insertCall,
  markCallStored,
  markCallFailed,
  updateCallHandler,
  listContacts,
  listCallsForContact,
  getCall,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  getLastSyncedAt,
  setLastSyncedAt,
};
