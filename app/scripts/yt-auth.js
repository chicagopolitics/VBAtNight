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
//
// ON A HEADLESS SERVER (the droplet): the callback listener runs *here*, but
// your browser runs on your laptop, so the http://127.0.0.1:PORT redirect
// resolves to your laptop and fails. That failure is harmless and the flow
// still completes — the authorization code is sitting in your browser's
// address bar. Run with `--manual` and paste the URL back. See below.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { exec } = require("child_process");

// Single source of truth — lib/youtube.js owns the scope list. Hardcoding it
// here is what silently broke re-titling: lib/youtube.js gained the `youtube`
// scope for videos.update, this script kept asking for upload-only, and
// re-running consent therefore changed nothing.
const MANUAL = process.argv.includes("--manual");
// Fixed by default so `ssh -L` can be set up before starting the flow; a
// random port can't be forwarded in advance.
const PORT = Number(process.env.YT_OAUTH_PORT || 42781);
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
const REDIRECT = `http://127.0.0.1:${PORT}`;

async function exchange(code) {
  const tok = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  })).json();
  if (!tok.refresh_token) throw new Error(tok.error_description || JSON.stringify(tok));
  return tok;
}

// Verify what Google actually GRANTED, not what we asked for. Consent screens
// let a user untick scopes, and a token that's missing `youtube` looks fine
// until a re-title fails days later — which is exactly how this bug reached
// production. Fail loudly here instead.
function report(tok, wanted) {
  const granted = new Set((tok.scope || "").split(/\s+/).filter(Boolean));
  const missing = wanted.filter(s => !granted.has(s));
  console.log("\n✓ Success! Put this in app/.env.local (replacing any old value):\n");
  console.log(`YT_OAUTH_REFRESH_TOKEN=${tok.refresh_token}\n`);
  console.log("Scopes granted:");
  for (const s of granted) console.log("  ✓ " + s.replace("https://www.googleapis.com/auth/", ""));
  if (missing.length) {
    console.log("\n⚠ MISSING — these were requested but not granted:");
    for (const s of missing) console.log("  ✗ " + s.replace("https://www.googleapis.com/auth/", ""));
    console.log("\nRe-run and make sure every box on the consent screen is ticked.");
    console.log("Without `youtube`, uploads work but `Re-sync title` will 403.");
    return false;
  }
  console.log("\nRestart the app (or the systemd unit) so it picks up the new token.");
  return true;
}

async function main() {
  const { SCOPE } = await import("../lib/youtube.js");
  const wanted = SCOPE.split(" ");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT,
      response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent", state });

  // --- manual mode: no listener, paste the redirected URL back -------------
  if (MANUAL) {
    console.log("Open this URL in a browser on ANY machine:\n\n" + authUrl + "\n");
    console.log("After you approve, the browser will try to load " + REDIRECT +
      " and fail\nwith \"can't connect\" — that is EXPECTED and fine. The code you " +
      "need is in\nthe address bar. Copy the whole URL and paste it here.\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question("Paste the redirected URL (or just the code): ", r));
    rl.close();
    const raw = answer.trim();
    let code = raw, gotState = null;
    if (raw.includes("?") || raw.startsWith("http")) {
      const u = new URL(raw.startsWith("http") ? raw : REDIRECT + raw);
      code = u.searchParams.get("code");
      gotState = u.searchParams.get("state");
    }
    if (!code) { console.error("\n✗ No `code` found in that."); process.exit(1); }
    if (gotState && gotState !== state) {
      console.error("\n✗ state mismatch — that URL is from a different run. Start over.");
      process.exit(1);
    }
    try { process.exit(report(await exchange(code), wanted) ? 0 : 1); }
    catch (e) { console.error("\n✗ Token exchange failed:", e.message); process.exit(1); }
  }

  // --- listener mode ------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (!url.searchParams.get("code")) { res.writeHead(404).end(); return; }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("state mismatch"); return;
    }
    let ok = false;
    try {
      const tok = await exchange(url.searchParams.get("code"));
      res.writeHead(200, { "content-type": "text/html" }).end(
        "<h2>Authorized ✓</h2><p>You can close this tab and return to the terminal.</p>");
      ok = report(tok, wanted);
    } catch (e) {
      res.writeHead(500).end("token exchange failed — see terminal");
      console.error("\n✗ Token exchange failed:", e.message);
    } finally {
      server.close();
      setTimeout(() => process.exit(ok ? 0 : 1), 200);
    }
  });

  server.on("error", e => {
    console.error(e.code === "EADDRINUSE"
      ? `\n✗ Port ${PORT} is already in use. Set YT_OAUTH_PORT=<free port> and retry.`
      : `\n✗ ${e.message}`);
    process.exit(1);
  });

  server.listen(PORT, "127.0.0.1", () => {
    // A remote shell means the browser is on a different machine, so the
    // loopback redirect cannot reach this listener.
    const remote = !!process.env.SSH_CONNECTION || !!process.env.SSH_TTY;
    if (remote) {
      console.log("⚠ This looks like an SSH session, so the browser is on your");
      console.log(`  laptop and ${REDIRECT} will NOT reach this server.\n`);
      console.log("  Either:");
      console.log(`    a) reconnect with a tunnel:  ssh -L ${PORT}:127.0.0.1:${PORT} ${
        process.env.USER || "root"}@<host>`);
      console.log("       then re-run this command, or");
      console.log("    b) run:  npm run yt-auth -- --manual   (no tunnel needed)\n");
    }
    console.log("Open this URL to authorize:\n\n" + authUrl + "\n");
    if (!remote) {
      const cmd = process.platform === "win32" ? `start "" "${authUrl}"`
        : process.platform === "darwin" ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
      exec(cmd, () => {});
    }
    console.log(`Waiting for the callback on ${REDIRECT} …`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
