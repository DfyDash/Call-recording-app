const NodeID3 = require("node-id3");

// Fallback only for when the account's real timezone couldn't be looked up
// (e.g. GHL API not configured, or the lookup failed). Matches this
// deployment's confirmed account; a different deployment should get its own
// real timezone from ghlApi.getAccountTimezone() rather than rely on this.
const DEFAULT_TIMEZONE = "America/Phoenix";

// occurredAt is always stored as a true UTC instant, but a timestamp shown
// to a human (in the file's own metadata, where nothing can auto-adjust for
// the viewer the way a browser does) needs to be in the account's own
// timezone -- otherwise a call at 9pm local shows as the next day in UTC,
// which is exactly backwards for someone trying to find "that 9pm call".
// Using the account's actual IANA timezone (rather than a fixed offset)
// also means daylight saving transitions are handled correctly.
function formatTimestamp(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || DEFAULT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "shortOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const offsetLabel = (parts.timeZoneName || "").replace("GMT", "UTC");
  // "2026-09-16 9:57 PM (UTC-7)" -- readable, and shows up wherever Title
  // does, since many basic file-properties viewers (unlike this app's own
  // dashboard) don't surface a Comment/Date field at all.
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod} (${offsetLabel})`;
}

function localDateOnly(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || DEFAULT_TIMEZONE }).format(date);
}

function buildComment({ occurredAt, direction, durationSeconds, contactName, phone, timezone }) {
  const parts = [];
  if (occurredAt) parts.push(`Recorded: ${formatTimestamp(occurredAt, timezone)}`);
  if (direction) parts.push(`Direction: ${direction}`);
  if (durationSeconds != null) parts.push(`Duration: ${durationSeconds}s`);
  const who = contactName || phone;
  if (who) parts.push(`Contact: ${who}`);
  return parts.join(" | ");
}

function buildTitle({ occurredAt, contactName, phone, direction, timezone }) {
  const who = contactName || phone || "unknown contact";
  const base = direction ? `Call with ${who} (${direction})` : `Call with ${who}`;
  return occurredAt ? `${formatTimestamp(occurredAt, timezone)} - ${base}` : base;
}

// --- WAV: inject a RIFF LIST/INFO chunk (read by Explorer/Finder/most players) ---

function riffChunk(id, dataBuffer) {
  const size = dataBuffer.length;
  const padded = size % 2 === 1;
  const buf = Buffer.alloc(8 + size + (padded ? 1 : 0));
  buf.write(id, 0, "ascii");
  buf.writeUInt32LE(size, 4);
  dataBuffer.copy(buf, 8);
  return buf;
}

function infoString(value) {
  return Buffer.concat([Buffer.from(String(value), "ascii"), Buffer.from([0])]);
}

// Strips any existing top-level LIST/INFO chunk so re-tagging a file (e.g.
// backfilling old recordings after a metadata-format change) replaces it
// instead of stacking a second, possibly-conflicting one.
function stripExistingInfoChunk(body) {
  const kept = [];
  let offset = 0;
  while (offset + 8 <= body.length) {
    const id = body.toString("ascii", offset, offset + 4);
    const size = body.readUInt32LE(offset + 4);
    const total = 8 + size + (size % 2);
    const isInfoList = id === "LIST" && body.toString("ascii", offset + 8, offset + 12) === "INFO";
    if (!isInfoList) kept.push(body.subarray(offset, offset + total));
    offset += total;
  }
  return Buffer.concat(kept);
}

function embedWavMetadata(buffer, meta) {
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return buffer; // not a recognizable WAV container -- leave untouched
  }

  const fields = {
    ICRD: meta.occurredAt ? localDateOnly(meta.occurredAt, meta.timezone) : null,
    INAM: buildTitle(meta),
    ICMT: buildComment(meta),
    IART: meta.contactName || meta.phone || null,
  };

  const subChunks = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([id, value]) => riffChunk(id, infoString(value)));

  const infoListChunk = riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "ascii"), ...subChunks]));

  const header = buffer.subarray(0, 12);
  const rest = stripExistingInfoChunk(buffer.subarray(12));
  const result = Buffer.concat([header, infoListChunk, rest]);
  result.writeUInt32LE(result.length - 8, 4); // update RIFF chunk size
  return result;
}

// --- MP3: standard ID3v2 tags ---

function embedMp3Metadata(buffer, meta) {
  const tagged = NodeID3.write(
    {
      title: buildTitle(meta),
      comment: { language: "eng", text: buildComment(meta) },
      year: meta.occurredAt ? String(meta.occurredAt.getUTCFullYear()) : undefined,
    },
    buffer
  );
  return Buffer.isBuffer(tagged) ? tagged : buffer;
}

function embedMetadata(buffer, extension, meta) {
  if (extension === "wav") return embedWavMetadata(buffer, meta);
  if (extension === "mp3") return embedMp3Metadata(buffer, meta);
  return buffer;
}

module.exports = { embedMetadata };
