#!/usr/bin/env node
// De-risk script. Answers ONE question, cheaply:
//
//   Does YouTube lock this project's API uploads as private?
//
// Unverified Cloud projects have their videos.insert uploads locked private
// with NO appeal (https://support.google.com/youtube/answer/7300965). We're
// going unlisted, so if that lock lands, every /watch embed is dead and the
// whole migration has to fall back to manual upload + paste-the-video-id.
//
// Better to learn that from a 3-second test pattern than from a 2.5 GB game
// upload, or worse, from production.
//
//   npm run yt-probe            # renders a tiny clip, uploads, reports
//   npm run yt-probe -- foo.mp4 # upload a file you already have
//
// It prints the video URL. DELETE THE VIDEO afterwards — this script never
// deletes anything (the OAuth scope is upload-only by design).
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// load .env.local the way next does, minus next
const ENV = path.join(process.cwd(), ".env.local");
if (fs.existsSync(ENV))
  for (const line of fs.readFileSync(ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }

const { uploadVideo, youtubeConfigured, defaultPrivacy } =
  await import("../lib/youtube.js");

if (!youtubeConfigured()) {
  console.error("YouTube not configured. Run `npm run yt-auth` first and add");
  console.error("YT_OAUTH_REFRESH_TOKEN to app/.env.local.");
  process.exit(1);
}

// Small mp4s already in the repo, used when ffmpeg isn't on PATH — which is
// the normal state of affairs on Windows, where this gets run.
const FALLBACKS = [
  "../pipeline/eval_v3_rally8.mp4",     // 3 MB, 18s, h264 720p
  "../pipeline/eval_v3_rally33.mp4",
];

let file = process.argv[2];
let temp = null;
if (!file) {
  // 3s of colour bars — small, obviously a test, nothing to moderate
  temp = path.join(os.tmpdir(), `yt-probe-${Date.now()}.mp4`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    temp], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    fs.rmSync(temp, { force: true });
    temp = null;
    file = FALLBACKS.map(f => path.resolve(process.cwd(), f))
      .find(f => fs.existsSync(f));
    if (!file) {
      console.error("No ffmpeg on PATH and no sample clip found.");
      console.error("Pass any small mp4:  npm run yt-probe -- path/to/small.mp4");
      process.exit(1);
    }
    console.log(`(no ffmpeg on PATH — using ${path.relative(process.cwd(), file)})`);
  } else {
    file = temp;
  }
}

const privacy = defaultPrivacy();
console.log(`Uploading ${path.basename(file)} ` +
  `(${(fs.statSync(file).size / 1e6).toFixed(1)} MB) as "${privacy}"…`);

try {
  const v = await uploadVideo(file, {
    title: `API probe — delete me (${new Date().toISOString().slice(0, 16)})`,
    description: "Throwaway upload testing API upload privacy. Safe to delete.",
    tags: ["test"],
    privacy,
    onProgress: (s, t) =>
      process.stdout.write(`\r  ${((s / t) * 100).toFixed(0)}%`),
  });
  console.log("\n");
  console.log("  video id       :", v.id);
  console.log("  requested      :", privacy);
  console.log("  YouTube says   :", v.privacyStatus);
  console.log("  upload status  :", v.uploadStatus,
    v.rejectionReason ? `(${v.rejectionReason})` : "");
  console.log("  url            :", v.url);
  console.log("");

  if (v.privacyStatus === privacy) {
    console.log("✓ RESULT: uploads keep the privacy you ask for.");
    console.log("  The automated path is viable. Wire up per-game upload.");
    console.log("  Confirm in YouTube Studio that it isn't flagged 'locked'.");
  } else {
    console.log("✗ RESULT: YouTube overrode the privacy " +
      `(asked ${privacy}, got ${v.privacyStatus}).`);
    console.log("  This is the unverified-project lock. Options:");
    console.log("   1. Fall back to MANUAL upload + paste the video id into");
    console.log("      the app. Everything downstream works identically.");
    console.log("   2. Apply for a YouTube API compliance audit:");
    console.log("      https://support.google.com/youtube/contact/yt_api_form");
    console.log("  Given we're going unlisted, option 1 costs ~20s per game.");
  }
  console.log("\nRemember to delete the probe video in YouTube Studio.");
} catch (e) {
  console.error("\n✗ Upload failed:", e.message);
  process.exitCode = 1;
} finally {
  if (temp) fs.rmSync(temp, { force: true });
}
