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
}) {
  const result = await pool.query(
    `INSERT INTO calls (
       id, ghl_call_id, ghl_contact_id, direction, duration_seconds,
       occurred_at, source_recording_url, recording_status, raw_payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
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

async function listContacts(search) {
  if (search) {
    const { rows } = await pool.query(
      `SELECT ghl_contact_id AS id, name, phone
       FROM contacts
       WHERE name ILIKE $1 OR phone ILIKE $1
       ORDER BY name NULLS LAST
       LIMIT 50`,
      [`%${search}%`]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT ghl_contact_id AS id, name, phone
     FROM contacts
     ORDER BY updated_at DESC
     LIMIT 50`
  );
  return rows;
}

async function listCallsForContact(contactId) {
  const { rows } = await pool.query(
    `SELECT id, direction, duration_seconds AS "durationSeconds",
            occurred_at AS "occurredAt", recording_status AS "recordingStatus",
            storage_key IS NOT NULL AS "hasRecording"
     FROM calls
     WHERE ghl_contact_id = $1
     ORDER BY occurred_at DESC NULLS LAST, created_at DESC`,
    [contactId]
  );
  return rows;
}

async function getCall(callId) {
  const { rows } = await pool.query(
    `SELECT id, storage_key AS "storageKey", recording_status AS "recordingStatus"
     FROM calls WHERE id = $1`,
    [callId]
  );
  return rows[0] || null;
}

module.exports = {
  pool,
  upsertContact,
  insertCall,
  markCallStored,
  markCallFailed,
  listContacts,
  listCallsForContact,
  getCall,
};
