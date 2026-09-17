const fs = require("fs");
const path = require("path");

const driver = process.env.STORAGE_DRIVER || "local";

// --- local disk driver (default, zero AWS setup needed for the prototype) ---

const localDir = path.resolve(process.env.STORAGE_LOCAL_DIR || "./data/recordings");

function localSave(key, buffer) {
  const filePath = path.join(localDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return key;
}

function localGetStream(key) {
  const filePath = path.join(localDir, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.createReadStream(filePath);
}

// --- S3 driver (for the eventual AWS deployment) ---

let s3Client;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({ region: process.env.S3_REGION });
  }
  return s3Client;
}

async function s3Save(key, buffer) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
    })
  );
  return key;
}

async function s3GetPresignedUrl(key) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: 3600 });
}

// --- public interface ---

async function saveRecording(key, buffer) {
  if (driver === "s3") return s3Save(key, buffer);
  return localSave(key, buffer);
}

// Returns either a redirect URL (s3) or a stream to pipe (local).
// Callers check which field is set.
async function getPlayback(key) {
  if (driver === "s3") {
    return { redirectUrl: await s3GetPresignedUrl(key) };
  }
  const stream = localGetStream(key);
  return { stream };
}

module.exports = { saveRecording, getPlayback, driver };
