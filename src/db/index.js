const { Pool } = require("pg");
const { randomUUID } = require("crypto");

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

async function markCallStored(callId, storageKey, durationSeconds) {
  if (durationSeconds !== undefined && durationSeconds !== null) {
    await pool.query(
      `UPDATE calls SET storage_key = $2, recording_status = 'stored', duration_seconds = $3 WHERE id = $1`,
      [callId, storageKey, durationSeconds]
    );
  } else {
    await pool.query(
      `UPDATE calls SET storage_key = $2, recording_status = 'stored' WHERE id = $1`,
      [callId, storageKey]
    );
  }
}

// Calls the live poller marked 'failed' recently -- GHL sometimes hasn't
// finished processing a call's recording (or even its final duration) at
// the moment the poller first sees the message (see src/poller.js's
// retryFailedRecordings), so these are worth one more look rather than
// treated as permanently missing the way an old backfilled call is.
async function listRetryableFailedCalls(maxAgeMs) {
  const { rows } = await pool.query(
    `SELECT c.id, c.ghl_call_id AS "ghlCallId", c.ghl_contact_id AS "contactId", c.raw_payload AS "rawPayload",
            c.direction, c.occurred_at AS "occurredAt",
            ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.recording_status = 'failed' AND c.occurred_at > now() - ($1 || ' milliseconds')::interval`,
    [maxAgeMs]
  );
  return rows;
}

// Cheap existence check for src/backfill.js -- lets it skip already-captured
// calls (from a prior run, or ones the live poller already picked up) without
// going through insertCall's conflict-and-discard path just to find out.
async function getCallByGhlId(ghlCallId) {
  const { rows } = await pool.query(`SELECT id FROM calls WHERE ghl_call_id = $1`, [ghlCallId]);
  return rows[0] || null;
}

async function markCallFailed(callId) {
  await pool.query(
    `UPDATE calls SET recording_status = 'failed' WHERE id = $1`,
    [callId]
  );
}

// --- transcription (src/transcription.js, src/transcriptionPoller.js) ---

async function markTranscriptionPending(callId) {
  await pool.query(`UPDATE calls SET transcription_status = 'pending' WHERE id = $1`, [callId]);
}

async function markTranscriptionComplete(callId, transcript) {
  await pool.query(
    `UPDATE calls SET transcription_status = 'completed', transcript = $2 WHERE id = $1`,
    [callId, transcript]
  );
}

async function markTranscriptionFailed(callId) {
  await pool.query(`UPDATE calls SET transcription_status = 'failed' WHERE id = $1`, [callId]);
}

async function listPendingTranscriptions() {
  const { rows } = await pool.query(`SELECT id FROM calls WHERE transcription_status = 'pending'`);
  return rows;
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

const PAGE_SIZES = [20, 50, 100];

// The main call-search query: contactId is optional (omitted = all
// contacts), dateFrom/dateTo are 'YYYY-MM-DD' strings and inclusive of the
// whole day on both ends. ghlUserId is the same RBAC scoping used
// everywhere else (a specific user's calls, or unrestricted for admins).
async function listCalls({ contactId, ghlUserId, dateFrom, dateTo, page = 1, pageSize = 20 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 20;
  const pageNum = Math.max(1, Number(page) || 1);

  const conditions = [];
  const params = [];
  if (contactId) {
    params.push(contactId);
    conditions.push(`c.ghl_contact_id = $${params.length}`);
  }
  if (ghlUserId) {
    params.push(ghlUserId);
    conditions.push(`c.handled_by_id = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM calls c ${where}`, params);
  const total = Number(countRows[0].count);

  const limitParams = [...params, size, (pageNum - 1) * size];
  const { rows } = await pool.query(
    `SELECT c.id, c.direction, c.duration_seconds AS "durationSeconds",
            c.occurred_at AS "occurredAt", c.recording_status AS "recordingStatus",
            c.storage_key IS NOT NULL AS "hasRecording", c.handled_by_name AS "handledByName",
            c.transcription_status AS "transcriptionStatus",
            c.ghl_contact_id AS "contactId", ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     ${where}
     ORDER BY c.occurred_at DESC NULLS LAST, c.created_at DESC
     LIMIT $${limitParams.length - 1} OFFSET $${limitParams.length}`,
    limitParams
  );
  return { calls: rows, total, page: pageNum, pageSize: size };
}

// Unpaginated, unlike listCalls() -- for the bulk ZIP export
// (routes/admin.js), which needs every matching row to stream, not one
// page. dateFrom/dateTo are optional, same semantics as listCalls().
async function listAllCallsWithRecordings({ dateFrom, dateTo } = {}) {
  const conditions = ["c.storage_key IS NOT NULL"];
  const params = [];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.storage_key AS "storageKey", c.occurred_at AS "occurredAt",
            c.direction, ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.occurred_at ASC NULLS LAST`,
    params
  );
  return rows;
}

async function getCall(callId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.storage_key AS "storageKey", c.recording_status AS "recordingStatus",
            c.occurred_at AS "occurredAt", c.direction, c.ghl_contact_id AS "contactId",
            c.handled_by_id AS "handledById", c.transcription_status AS "transcriptionStatus",
            c.transcript, ct.name, ct.phone
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

// --- app_settings (live, admin-toggleable -- see src/poller.js) ---

async function getAutoTranscribeEnabled() {
  const { rows } = await pool.query(
    `SELECT auto_transcribe_enabled AS "autoTranscribeEnabled" FROM app_settings WHERE id = 1`
  );
  return rows[0] ? rows[0].autoTranscribeEnabled : false;
}

async function setAutoTranscribeEnabled(enabled) {
  await pool.query(`UPDATE app_settings SET auto_transcribe_enabled = $1 WHERE id = 1`, [enabled]);
}

// --- audit_log (who changed what admin setting/account, and when) ---

async function logAudit({ actorId, actorUsername, action, message }) {
  await pool.query(
    `INSERT INTO audit_log (id, actor_id, actor_username, action, message) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), actorId || null, actorUsername || null, action, message]
  );
}

async function listAuditLog({ page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log`);
  const total = Number(countRows[0].count);

  // COALESCE to the GHL name currently linked to the actor's user account,
  // falling back to the username recorded at the time (matters once that
  // link changes, or if the account has since been deleted).
  const { rows } = await pool.query(
    `SELECT l.id, l.actor_id AS "actorId", COALESCE(u.ghl_user_name, l.actor_username) AS "actorUsername",
            l.action, l.message, l.created_at AS "createdAt"
     FROM audit_log l
     LEFT JOIN users u ON u.id = l.actor_id
     ORDER BY l.created_at DESC
     LIMIT $1 OFFSET $2`,
    [size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

// --- phi_access_log (who accessed which call's recording/transcript,
// when, from where, how, and whether it was allowed -- see routes/api.js) ---

async function logPhiAccess({ userId, username, action, callId, success, denialReason, ipAddress, userAgent }) {
  await pool.query(
    `INSERT INTO phi_access_log
       (id, user_id, username, action, call_id, success, denial_reason, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), userId || null, username || null, action, callId || null, success, denialReason || null, ipAddress || null, userAgent || null]
  );
}

async function listPhiAccessLog({ page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM phi_access_log`);
  const total = Number(countRows[0].count);

  // LEFT JOINs purely for display -- which contact this call belongs to,
  // and the GHL name currently linked to the accessing user's account
  // (falling back to the username recorded at the time). The log itself
  // never depends on any of these still existing.
  const { rows } = await pool.query(
    `SELECT l.id, l.user_id AS "userId", COALESCE(u.ghl_user_name, l.username) AS username,
            l.action, l.call_id AS "callId", l.success,
            l.denial_reason AS "denialReason", l.ip_address AS "ipAddress", l.user_agent AS "userAgent",
            l.created_at AS "createdAt", ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM phi_access_log l
     LEFT JOIN calls c ON c.id = l.call_id
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.created_at DESC
     LIMIT $1 OFFSET $2`,
    [size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

module.exports = {
  pool,
  upsertContact,
  insertCall,
  getCallByGhlId,
  markCallStored,
  markCallFailed,
  listRetryableFailedCalls,
  markTranscriptionPending,
  markTranscriptionComplete,
  markTranscriptionFailed,
  listPendingTranscriptions,
  updateCallHandler,
  listContacts,
  listCalls,
  listAllCallsWithRecordings,
  getCall,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  getLastSyncedAt,
  setLastSyncedAt,
  getAutoTranscribeEnabled,
  setAutoTranscribeEnabled,
  logAudit,
  listAuditLog,
  logPhiAccess,
  listPhiAccessLog,
};
