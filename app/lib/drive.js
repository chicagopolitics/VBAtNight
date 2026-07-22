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
import { Readable } from "stream";
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

// stream a Drive file to a local path
export async function downloadFile(fileId, destPath) {
  const token = await accessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body)
    throw new Error("Drive download failed: HTTP " + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}
