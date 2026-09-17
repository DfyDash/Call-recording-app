const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const CALL_MESSAGE_TYPE = 1; // GHL's Conversations message type for phone calls

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
    Version: GHL_API_VERSION,
    Accept: "application/json",
  };
}

function isConfigured() {
  return Boolean(process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID);
}

// Conversations sorted by most recent activity, across the whole
// sub-account -- no contactId filter, so this is what the poller scans on
// each cycle to find anything new. GHL's "recording URL" isn't exposed on
// call messages at all (confirmed against GHL's own docs), which is why
// this app pulls call data via this API rather than a GHL workflow/webhook.
async function searchConversations(limit = 100) {
  const url = new URL(`${GHL_API_BASE}/conversations/search`);
  url.searchParams.set("locationId", process.env.GHL_LOCATION_ID);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "desc");
  url.searchParams.set("sortBy", "last_message_date");
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`conversations/search failed with status ${res.status}`);
  const data = await res.json();
  return data.conversations || [];
}

// One page of the full conversation history, oldest-sortable via cursor
// (startAfterDate/startAfterId, echoing the last conversation of the
// previous page) -- for src/backfill.js, which has to walk the *entire*
// account history rather than just the most recent page (what
// searchConversations above is for). Returns the raw conversations array;
// the caller decides whether another page follows (fewer than `limit`
// results back means this was the last page).
async function searchConversationsPage({ limit = 100, sort = "asc", startAfterDate, startAfterId } = {}) {
  const url = new URL(`${GHL_API_BASE}/conversations/search`);
  url.searchParams.set("locationId", process.env.GHL_LOCATION_ID);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", sort);
  url.searchParams.set("sortBy", "last_message_date");
  if (startAfterDate) url.searchParams.set("startAfterDate", String(startAfterDate));
  if (startAfterId) url.searchParams.set("startAfterId", startAfterId);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`conversations/search (paginated) failed with status ${res.status}`);
  const data = await res.json();
  return data.conversations || [];
}

// Every call-type message in a conversation (GHL mixes calls, SMS, emails,
// etc. into the same message list).
async function listCallMessages(conversationId) {
  const url = `${GHL_API_BASE}/conversations/${conversationId}/messages`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`conversations/messages failed with status ${res.status}`);
  const data = await res.json();
  const messages = (data.messages && data.messages.messages) || [];
  return messages.filter((m) => m.type === CALL_MESSAGE_TYPE);
}

async function downloadRecording(messageId) {
  const url = `${GHL_API_BASE}/conversations/messages/${messageId}/locations/${process.env.GHL_LOCATION_ID}/recording`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`get-message-recording failed with status ${res.status}`);
  const contentType = res.headers.get("content-type") || "audio/x-wav";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

// Cached for the process lifetime, same reasoning as the timezone cache --
// resolves a GHL userId to a display name without a lookup on every call.
let cachedUsersById = null;

async function getUserName(userId) {
  if (!userId) return null;
  if (!cachedUsersById) {
    const users = await listUsers();
    cachedUsersById = new Map(users.map((u) => [u.id, u.name]));
  }
  return cachedUsersById.get(userId) || null;
}

// Cached for the process lifetime -- a sub-account's timezone essentially
// never changes, and this saves an API call on every poll cycle.
let cachedTimezone = null;

// Fetches the sub-account's actual configured timezone (an IANA name like
// "America/Phoenix") so call timestamps display correctly for whichever
// account this is deployed against, including DST, instead of relying on a
// hand-configured fixed UTC offset that only happens to be right for one
// account and one season.
async function getAccountTimezone() {
  if (cachedTimezone) return cachedTimezone;
  if (!isConfigured()) return null;

  const url = `${GHL_API_BASE}/locations/${process.env.GHL_LOCATION_ID}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.warn(`[ghlApi] could not fetch location timezone, status ${res.status}`);
    return null;
  }
  const data = await res.json();
  const timezone = (data.location && data.location.timezone) || data.timezone || null;
  if (timezone) cachedTimezone = timezone;
  return timezone;
}

// Fetches the sub-account's GHL user list, trimmed to just what the admin
// UI needs to map a login account to the identity that appears on their
// calls -- not the full response, which includes each user's entire GHL
// permission-scope list and other internal detail with no reason to leave
// this server.
async function listUsers() {
  const url = new URL(`${GHL_API_BASE}/users/`);
  url.searchParams.set("locationId", process.env.GHL_LOCATION_ID);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`users list failed with status ${res.status}`);
  const data = await res.json();
  return (data.users || []).map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

module.exports = {
  isConfigured,
  searchConversations,
  searchConversationsPage,
  listCallMessages,
  downloadRecording,
  getUserName,
  getAccountTimezone,
  listUsers,
};
