#!/usr/bin/env node
// One-time YouTube authorization (user OAuth) — the same dance as
// drive-auth.js, different scope and different env var names.
//
// Deliberately a SEPARATE OAuth client from Drive's: Drive import/export
// works today, and re-running consent on that client to widen its scopes
// risks breaking a working feature for one that the API audit may block
// anyway (see YOUTUBE-PLAN.md).
//
// Prereq: an OAuth 2.0 Client ID of type "Desktop app" in a Cloud project
// with the *YouTube Data API v3* enabled. Put it in app/.env.local as:
//   YT_OAUTH_CLIENT_ID=...
//   YT_OAUTH_CLIENT_SECRET=...
// then run:  npm run yt-auth
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const ENV = path.join(process.cwd(), ".env.local");

function readEnv() {
  const out = {};
  if (fs.existsSync(ENV))
    for (const line of fs.readFileSync(ENV, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  return out;
}

const env = { ...readEnv(), ...process.env };
const CLIENT_ID = env.YT_OAUTH_CLIENT_ID;
const CLIENT_SECRET = env.YT_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing YT_OAUTH_CLIENT_ID / YT_OAUTH_CLIENT_SECRET.\n" +
    "Add them to app/.env.local first (see YOUTUBE-PLAN.md), then re-run.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (!url.searchParams.get("code")) { res.writeHead(404).end(); return; }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch"); return;
  }
  try {
    const tok = await (await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code"),
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: `http://127.0.0.1:${port}`,
        grant_type: "authorization_code" }),
    })).json();
    if (!tok.refresh_token) throw new Error(JSON.stringify(tok));
    res.writeHead(200, { "content-type": "text/html" }).end(
      "<h2>Authorized ✓</h2><p>You can close this tab and return to the terminal.</p>");
    console.log("\n✓ Success! Add this line to app/.env.local:\n");
    console.log(`YT_OAUTH_REFRESH_TOKEN=${tok.refresh_token}\n`);
    console.log("Then run `npm run yt-probe` — it does ONE throwaway upload to");
    console.log("find out whether YouTube locks API uploads private on your");
    console.log("project. Do that before relying on this in a workflow.");
  } catch (e) {
    res.writeHead(500).end("token exchange failed — see terminal");
    console.error("\n✗ Token exchange failed:", e.message);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

let port;
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  const auth = "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: `http://127.0.0.1:${port}`,
      response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent", state });
  console.log("Opening Google consent in your browser…");
  console.log("If it doesn't open, paste this URL:\n\n" + auth + "\n");
  const cmd = process.platform === "win32" ? `start "" "${auth}"`
    : process.platform === "darwin" ? `open "${auth}"` : `xdg-open "${auth}"`;
  exec(cmd, () => {});
});
