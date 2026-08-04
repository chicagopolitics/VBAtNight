// YouTube Data API v3 — upload a game video to Ken's channel. No SDK, same
// shape as lib/drive.js (refresh-token OAuth, hand-rolled fetch) so there's
// one auth pattern in this codebase, not two.
//
//   YT_OAUTH_CLIENT_ID
//   YT_OAUTH_CLIENT_SECRET
//   YT_OAUTH_REFRESH_TOKEN     (from `npm run yt-auth`)
//   YT_PRIVACY                 unlisted (default) | public | private
//
// Falls back to the GOOGLE_OAUTH_* Drive credentials if the YT_* ones are
// unset AND the Drive consent included the YouTube scope — but a separate
// client is cleaner: Drive works today and re-consenting it risks breaking
// imports for a feature that might get blocked by the audit anyway.
//
// ⚠ Read YOUTUBE-PLAN.md before wiring this into a workflow. Videos uploaded
// by an UNVERIFIED Cloud project may be locked private with no appeal, which
// would make unlisted embeds unusable. `npm run yt-probe` answers that
// question with one throwaway upload. Until it does, treat this module as
// unproven and use manual upload + "paste video id".
import fs from "fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// youtube.upload is the minimum for videos.insert. Deliberately NOT the full
// `youtube` scope: this code never reads, edits or deletes anything on the
// channel, and the consent screen should say so.
export const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

function creds() {
  const id = process.env.YT_OAUTH_CLIENT_ID;
  const secret = process.env.YT_OAUTH_CLIENT_SECRET;
  const refresh = process.env.YT_OAUTH_REFRESH_TOKEN;
  return id && secret && refresh ? { id, secret, refresh } : null;
}

export function youtubeConfigured() { return !!creds(); }

export function defaultPrivacy() {
  const p = (process.env.YT_PRIVACY || "unlisted").toLowerCase();
  return ["public", "unlisted", "private"].includes(p) ? p : "unlisted";
}

let _tok = null;
async function accessToken() {
  if (_tok && Date.now() < _tok.exp - 60_000) return _tok.token;
  const c = creds();
  if (!c) throw new Error("YouTube not configured — run `npm run yt-auth`");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token",
      client_id: c.id, client_secret: c.secret, refresh_token: c.refresh }),
  });
  const j = await res.json();
  if (!res.ok)
    throw new Error("YouTube auth failed: " + (j.error_description || j.error));
  _tok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.token;
}

// Resumable upload. Multipart would buffer a 2.5 GB game in process memory —
// the exact failure mode that OOM-killed the droplet on Drive imports
// (commit c784ea2). Resumable streams from disk in chunks and, more usefully,
// survives a dropped connection: a 2.5 GB push over a home uplink WILL be
// interrupted, and restarting from byte 0 each time never terminates.
const CHUNK = 8 * 1024 * 1024;   // 8 MiB — multiple of 256 KiB, as required

// Start a resumable session; returns the upload URL to PUT chunks at.
async function startSession(meta, size, mimeType) {
  const token = await accessToken();
  const url = "https://www.googleapis.com/upload/youtube/v3/videos" +
    "?uploadType=resumable&part=snippet,status";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": mimeType,
    },
    body: JSON.stringify(meta),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || "YouTube session start failed: HTTP " + res.status);
  }
  const loc = res.headers.get("location");
  if (!loc) throw new Error("YouTube returned no resumable upload URL");
  return loc;
}

// Ask YouTube how many bytes it actually has, so a resume starts at the
// right offset instead of guessing.
async function committedBytes(sessionUrl, size) {
  const token = await accessToken();
  const res = await fetch(sessionUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`,
      "content-range": `bytes */${size}` },
  });
  if (res.status === 200 || res.status === 201) return size;   // already done
  if (res.status !== 308) throw new Error("resume query failed: HTTP " + res.status);
  const range = res.headers.get("range");           // "bytes=0-1048575"
  return range ? Number(range.split("-")[1]) + 1 : 0;
}

/**
 * Upload a video file to the authorized channel.
 *
 * @param {string} filePath      local path to the mp4
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.description]
 * @param {string[]} [o.tags]
 * @param {string} [o.privacy]   default from YT_PRIVACY (unlisted)
 * @param {function} [o.onProgress]  (sentBytes, totalBytes) => void
 * @returns {{id: string, privacyStatus: string, uploadStatus: string, url: string}}
 */
export async function uploadVideo(filePath, o = {}) {
  const size = fs.statSync(filePath).size;
  const privacy = o.privacy || defaultPrivacy();
  const meta = {
    snippet: {
      title: (o.title || "Game").slice(0, 100),        // YouTube hard limit
      description: (o.description || "").slice(0, 5000),
      tags: o.tags || ["volleyball"],
      categoryId: "17",                                 // Sports
    },
    status: {
      privacyStatus: privacy,
      selfDeclaredMadeForKids: false,
      embeddable: true,          // required — /watch plays these in an iframe
    },
  };

  const sessionUrl = await startSession(meta, size, "video/mp4");
  // positional reads off one fd: peak memory is CHUNK (8 MiB), not the file.
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(CHUNK);
  let sent = 0;

  try {
  while (sent < size) {
    const end = Math.min(sent + CHUNK, size) - 1;
    const n = fs.readSync(fd, buf, 0, end - sent + 1, sent);
    const body = buf.subarray(0, n);
    let res;
    try {
      const token = await accessToken();
      res = await fetch(sessionUrl, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`,
          "content-length": String(n),
          "content-range": `bytes ${sent}-${sent + n - 1}/${size}` },
        body,
      });
    } catch (netErr) {
      // connection died mid-chunk: ask YouTube where it got to and continue
      sent = await committedBytes(sessionUrl, size);
      continue;
    }
    if (res.status === 308) {                          // chunk accepted, more wanted
      const range = res.headers.get("range");
      sent = range ? Number(range.split("-")[1]) + 1 : end + 1;
      o.onProgress?.(sent, size);
      continue;
    }
    if (res.status === 200 || res.status === 201) {
      const j = await res.json();
      o.onProgress?.(size, size);
      return {
        id: j.id,
        privacyStatus: j.status?.privacyStatus,
        uploadStatus: j.status?.uploadStatus,
        rejectionReason: j.status?.rejectionReason || null,
        url: `https://www.youtube.com/watch?v=${j.id}`,
      };
    }
    if (res.status === 503 || res.status === 500) {    // transient: resume
      sent = await committedBytes(sessionUrl, size);
      continue;
    }
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || "YouTube upload failed: HTTP " + res.status);
  }
  } finally { fs.closeSync(fd); }
  throw new Error("YouTube upload ended without a video id");
}
