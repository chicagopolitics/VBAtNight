// Google Drive access — no SDK. Two auth methods (see DRIVE-SETUP.md):
//
//   USER OAUTH (preferred, production-shaped): the app acts as YOU, so files
//   it creates are owned by you and use your quota. This is the pattern a
//   multi-user app ships — per-user refresh tokens, just stored in env here.
//     GOOGLE_OAUTH_CLIENT_ID
//     GOOGLE_OAUTH_CLIENT_SECRET
//     GOOGLE_OAUTH_REFRESH_TOKEN   (from `npm run drive-auth`)
//
//   SERVICE ACCOUNT (fallback, read-only in practice): can list/download
//   shared bundles, but CANNOT upload to a consumer Drive (a service account
//   has no storage quota there). Kept so imports keep working mid-migration.
//     GOOGLE_SA_KEY                path to the JSON key (or the JSON itself)
//
//   DRIVE_FOLDER_ID                the folder id (from its Drive URL)
import crypto from "crypto";
import fs from "fs";
import { pipeline } from "stream/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// full drive scope: read/list bundles (not app-created, so drive.file won't
// see them) AND upload corrections back. The app never deletes/trashes.
export const SCOPE = "https://www.googleapis.com/auth/drive";

function oauthCreds() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  return id && secret && refresh ? { id, secret, refresh } : null;
}

function saKey() {
  const v = process.env.GOOGLE_SA_KEY;
  if (!v) return null;
  try {
    const json = v.trim().startsWith("{") ? v : fs.readFileSync(v, "utf8");
    const k = JSON.parse(json);
    return k.client_email && k.private_key ? k : null;
  } catch { return null; }
}

export function driveConfigured() {
  return !!((oauthCreds() || saKey()) && process.env.DRIVE_FOLDER_ID);
}
// can the app WRITE (upload corrections)? only user OAuth can, on a
// consumer account
export function driveCanUpload() {
  return !!(oauthCreds() && process.env.DRIVE_FOLDER_ID);
}

let _tok = null;   // { token, exp }
async function accessToken() {
  if (_tok && Date.now() < _tok.exp - 60_000) return _tok.token;
  const oauth = oauthCreds();
  const res = oauth ? await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token",
      client_id: oauth.id, client_secret: oauth.secret,
      refresh_token: oauth.refresh }),
  }) : await serviceAccountTokenReq();
  const j = await res.json();
  if (!res.ok) throw new Error("Drive auth failed: " + (j.error_description || j.error));
  _tok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.token;
}

// service-account JWT grant (fallback path)
function serviceAccountTokenReq() {
  const key = saKey();
  if (!key) throw new Error("Drive not configured (no OAuth refresh token or SA key)");
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." +
    b64({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL,
          iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned)
    .sign(key.private_key, "base64url");
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + sig }),
  });
}

// zip bundles in the shared folder (and one level of subfolders, so
// Drive/VBAtNight/bundles works whichever folder was shared)
export async function listBundles() {
  const token = await accessToken();
  const root = process.env.DRIVE_FOLDER_ID;
  const q = async query => {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", query);
    u.searchParams.set("fields", "files(id,name,size,modifiedTime,mimeType)");
    u.searchParams.set("orderBy", "modifiedTime desc");
    u.searchParams.set("pageSize", "100");
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("includeItemsFromAllDrives", "true");
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (!res.ok) throw new Error("Drive list failed: " + (j.error?.message || res.status));
    return j.files || [];
  };
  const inFolder = id => `'${id}' in parents and trashed = false`;
  const kids = await q(inFolder(root));
  const subfolders = kids.filter(f => f.mimeType === "application/vnd.google-apps.folder");
  const zips = kids.filter(f => f.name.endsWith(".zip"));
  for (const sub of subfolders)
    zips.push(...(await q(inFolder(sub.id))).filter(f => f.name.endsWith(".zip")));
  return zips.map(f => ({ id: f.id, name: f.name, size: +f.size || 0,
    modified: f.modifiedTime }));
}

// upload (or overwrite) a small text file in the shared folder. Returns the
// file's Drive id + name. Upserts by name so re-exporting replaces the file
// rather than making duplicates the notebook would glob twice.
// NB: on consumer (non-Workspace) Google accounts a service account has no
// storage of its own, so this can fail with a quota error even for tiny
// files — the caller surfaces that message.
export async function uploadFile(name, content, mimeType = "application/json") {
  const token = await accessToken();
  const folder = process.env.DRIVE_FOLDER_ID;
  // existing file with this name in the folder?
  const u = new URL("https://www.googleapis.com/drive/v3/files");
  u.searchParams.set("q", `name = '${name.replace(/'/g, "\\'")}' and ` +
    `'${folder}' in parents and trashed = false`);
  u.searchParams.set("fields", "files(id)");
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  const found = await (await fetch(u,
    { headers: { authorization: `Bearer ${token}` } })).json();
  const existing = found.files?.[0]?.id;

  const boundary = "btb" + Date.now();
  const meta = existing ? {} : { name, parents: [folder] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n` +
    content + `\r\n--${boundary}--`;
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;
  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${token}`,
      "content-type": `multipart/related; boundary=${boundary}` },
    body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(j.error?.message || "Drive upload failed: HTTP " + res.status);
  return { id: j.id, name: j.name || name, updated: !!existing };
}

// the `bundles` subfolder if the shared folder has one, else the shared
// folder itself. Mirrors listBundles(), which searches both — so an upload
// lands where the app already looks, and where the Colab notebook put them.
export async function bundlesFolderId() {
  const token = await accessToken();
  const root = process.env.DRIVE_FOLDER_ID;
  const u = new URL("https://www.googleapis.com/drive/v3/files");
  u.searchParams.set("q", `'${root}' in parents and trashed = false and ` +
    `mimeType = 'application/vnd.google-apps.folder' and name = 'bundles'`);
  u.searchParams.set("fields", "files(id)");
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  const j = await (await fetch(u,
    { headers: { authorization: `Bearer ${token}` } })).json();
  return j.files?.[0]?.id || root;
}

// upload a LARGE file (a multi-GB game bundle) via Drive's resumable protocol.
//
// Not uploadFile(): that builds the whole request body as a JS string, which
// is correct for a corrections JSON and impossible for 4 GB — the same trap
// downloadFile() already documents on the read side. Here the file is sent in
// fixed chunks read straight from disk, so peak memory is one chunk no matter
// how big the bundle is.
//
// Chunked rather than one long PUT because this now runs from a HOME
// connection: with Colab the bytes never left Google's network, but a local
// pipeline uploading ~4 GB upstream will meet a dropped connection sooner or
// later. On failure we ask the session how many bytes it actually holds and
// carry on from there instead of restarting the upload.
const CHUNK = 16 * 1024 * 1024;   // must be a multiple of 256 KB

export async function uploadLargeFile(localPath, name,
                                      mimeType = "application/zip",
                                      onProgress = null) {
  const folder = await bundlesFolderId();
  const total = fs.statSync(localPath).size;

  // upsert by name, like uploadFile — re-processing a game replaces its
  // bundle rather than leaving two that the ball notebook would glob twice.
  let token = await accessToken();
  const q = new URL("https://www.googleapis.com/drive/v3/files");
  q.searchParams.set("q", `name = '${name.replace(/'/g, "\\'")}' and ` +
    `'${folder}' in parents and trashed = false`);
  q.searchParams.set("fields", "files(id)");
  q.searchParams.set("supportsAllDrives", "true");
  q.searchParams.set("includeItemsFromAllDrives", "true");
  const found = await (await fetch(q,
    { headers: { authorization: `Bearer ${token}` } })).json();
  const existing = found.files?.[0]?.id;

  const startUrl = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=resumable&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`;
  const start = await fetch(startUrl, {
    method: existing ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(total) },
    body: JSON.stringify(existing ? {} : { name, parents: [folder] }),
  });
  if (!start.ok) {
    const j = await start.json().catch(() => ({}));
    throw new Error(j.error?.message || "Drive upload session failed: HTTP " + start.status);
  }
  const session = start.headers.get("location");
  if (!session) throw new Error("Drive gave no resumable session URI");

  const fd = fs.openSync(localPath, "r");
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    let sent = 0;
    let attempt = 0;
    while (sent < total) {
      const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, total - sent), sent);
      token = await accessToken();          // a 4 GB upload outlives one token
      let res;
      try {
        res = await fetch(session, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`,
            "content-range": `bytes ${sent}-${sent + len - 1}/${total}` },
          body: buf.subarray(0, len),
        });
      } catch (e) {
        res = null;                          // network dropped mid-chunk
        if (++attempt > 5) throw e;
      }
      if (res && (res.status === 200 || res.status === 201)) {
        const j = await res.json().catch(() => ({}));
        return { id: j.id, name: j.name || name, updated: !!existing, bytes: total };
      }
      if (res && res.status === 308) {
        const range = res.headers.get("range");           // "bytes=0-N"
        sent = range ? Number(range.split("-")[1]) + 1 : sent + len;
        attempt = 0;
        if (onProgress) onProgress(sent, total);
        continue;
      }
      // Anything else: ask the session what it actually holds, then resume.
      if (++attempt > 5) {
        const detail = res ? `HTTP ${res.status}` : "network error";
        throw new Error(`Drive upload failed after ${attempt} attempts (${detail})`);
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
      const probe = await fetch(session, {
        method: "PUT",
        headers: { authorization: `Bearer ${await accessToken()}`,
          "content-range": `bytes */${total}` },
      });
      if (probe.status === 200 || probe.status === 201) {
        const j = await probe.json().catch(() => ({}));
        return { id: j.id, name: j.name || name, updated: !!existing, bytes: total };
      }
      const r = probe.headers.get("range");
      sent = r ? Number(r.split("-")[1]) + 1 : sent;
    }
  } finally {
    fs.closeSync(fd);
  }
  throw new Error("Drive upload ended without a completion response");
}

// stream a Drive file to a local path.
// Uses node:https directly instead of fetch: with multi-GB bundles the
// fetch-based version buffered the whole body in process memory (~3.6GB
// anon RSS -> OOM-killed on a 4GB droplet). Native streams give end-to-end
// backpressure: the socket only reads as fast as the disk drains.
export async function downloadFile(fileId, destPath) {
  const token = await accessToken();
  const { get } = await import("https");
  let url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  for (let hop = 0; hop < 4; hop++) {
    const res = await new Promise((resolve, reject) =>
      get(url, { headers: { authorization: `Bearer ${token}` } }, resolve)
        .on("error", reject));
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();                       // drain + follow redirect
      url = res.headers.location;
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error("Drive download failed: HTTP " + res.statusCode);
    }
    await pipeline(res, fs.createWriteStream(destPath));
    return;
  }
  throw new Error("Drive download failed: too many redirects");
}
