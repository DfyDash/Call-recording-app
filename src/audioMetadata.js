const NodeID3 = require("node-id3");

function buildComment({ occurredAt, direction, durationSeconds, contactName, phone }) {
  const parts = [];
  if (occurredAt) parts.push(`Recorded: ${occurredAt.toISOString()}`);
  if (direction) parts.push(`Direction: ${direction}`);
  if (durationSeconds != null) parts.push(`Duration: ${durationSeconds}s`);
  const who = contactName || phone;
  if (who) parts.push(`Contact: ${who}`);
  return parts.join(" | ");
}

function buildTitle({ contactName, phone, direction }) {
  const who = contactName || phone || "unknown contact";
  return direction ? `Call with ${who} (${direction})` : `Call with ${who}`;
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

function embedWavMetadata(buffer, meta) {
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return buffer; // not a recognizable WAV container -- leave untouched
  }

  const fields = {
    ICRD: meta.occurredAt ? meta.occurredAt.toISOString().slice(0, 10) : null,
    INAM: buildTitle(meta),
    ICMT: buildComment(meta),
    IART: meta.contactName || meta.phone || null,
  };

  const subChunks = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([id, value]) => riffChunk(id, infoString(value)));

  const infoListChunk = riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "ascii"), ...subChunks]));

  const header = buffer.subarray(0, 12);
  const rest = buffer.subarray(12);
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
