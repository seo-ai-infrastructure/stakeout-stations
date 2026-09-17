// Run on the controlled capture runner after ADB/RPA has written real files.
// Credentials stay in environment variables, never command-line arguments.
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
const manifestPath = process.argv[2];
if (!manifestPath)
  throw Error("Usage: node scripts/upload-capture.mjs manifest.json");
const base = new URL(process.env.STAKEOUT_CAPTURE_URL || "");
if (base.protocol !== "https:") throw Error("HTTPS capture URL required");
const token = process.env.STAKEOUT_CAPTURE_TOKEN;
if (!token) throw Error("STAKEOUT_CAPTURE_TOKEN is required");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const artifacts = [];
for (const item of manifest.artifacts) {
  const file = resolve(dirname(manifestPath), item.file);
  const info = await stat(file);
  if (!info.isFile()) throw Error("Artifact must be a file");
  artifacts.push({ ...item, file, bytes: info.size });
}
async function post(path, body) {
  const response = await fetch(base.href.replace(/\/$/, "") + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  });
  if (!response.ok)
    throw Error(
      `Capture ${path} failed (${response.status}); no capture claimed as complete`,
    );
  return response.json();
}
const prepared = await post("/prepare", {
  ...manifest,
  id: manifest.id || randomUUID(),
  artifacts: artifacts.map(({ kind, mime, bytes }) => ({ kind, mime, bytes })),
});
console.log(JSON.stringify({ captureId: prepared.id, status: "uploading" }));
for (const upload of prepared.uploads) {
  const file = artifacts.find((a) => a.kind === upload.kind);
  const url = new URL(upload.signedUrl);
  if (url.protocol !== "https:") throw Error("Invalid upload destination");
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.bytes),
      "x-upsert": "false",
    },
    body: createReadStream(file.file),
    duplex: "half",
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw Error(`Artifact upload failed (${response.status})`);
}
const completed = await post("/complete", { id: prepared.id });
console.log(
  JSON.stringify({ captureId: completed.id, status: completed.status }),
);
