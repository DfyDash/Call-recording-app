const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const CALL_MESSAGE_TYPE = 1; // GHL's Conversations message type for phone calls
const MATCH_WINDOW_MS = 5 * 60 * 1000; // tolerate up to 5min clock/logging drift

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

async function findConversationId(contactId) {
  const url = new URL(`${GHL_API_BASE}/conversations/search`);
  url.searchParams.set("locationId", process.env.GHL_LOCATION_ID);
  url.searchParams.set("contactId", contactId);

  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`conversations/search failed with status ${res.status}`);
  const data = await res.json();
  const conversation = (data.conversations || [])[0];
  return conversation ? conversation.id : null;
}

async function findCallMessageId(conversationId, occurredAt) {
  const url = `${GHL_API_BASE}/conversations/${conversationId}/messages`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`conversations/messages failed with status ${res.status}`);
  const data = await res.json();
  const messages = (data.messages && data.messages.messages) || [];

  const calls = messages.filter((m) => m.type === CALL_MESSAGE_TYPE);
  if (calls.length === 0) return null;

  if (!occurredAt) return calls[0].id;

  let best = null;
  let bestDelta = Infinity;
  for (const m of calls) {
    const delta = Math.abs(new Date(m.dateAdded).getTime() - occurredAt.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = m;
    }
  }
  return bestDelta <= MATCH_WINDOW_MS ? best.id : null;
}

async function fetchRecording(messageId) {
  const url = `${GHL_API_BASE}/conversations/messages/${messageId}/locations/${process.env.GHL_LOCATION_ID}/recording`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`get-message-recording failed with status ${res.status}`);
  const contentType = res.headers.get("content-type") || "audio/x-wav";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

// Looks up and downloads the recording for a completed call via GHL's API,
// since the Call Completed webhook trigger doesn't expose a recording URL
// merge field at all -- confirmed against GHL's own docs.
async function findCallRecording({ contactId, occurredAt }) {
  const conversationId = await findConversationId(contactId);
  if (!conversationId) return null;

  const messageId = await findCallMessageId(conversationId, occurredAt);
  if (!messageId) return null;

  return fetchRecording(messageId);
}

// Cached for the process lifetime -- a sub-account's timezone essentially
// never changes, and this saves an API call on every single webhook.
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

module.exports = { isConfigured, findCallRecording, getAccountTimezone };
