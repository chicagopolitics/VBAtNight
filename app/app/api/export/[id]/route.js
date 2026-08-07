import { buildCorrections } from "@/lib/export";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { driveCanUpload, uploadFile } from "@/lib/drive";
import fs from "fs";
import path from "path";

// Writes corrections_<stem>.json into the app folder (process.cwd()) — the
// same place `npm run export` writes — instead of a browser download, so the
// file is already where the Colab-upload step expects it.
// IMPORTANT: the file stem must match the VIDEO stem (cca-one.mp4 ->
// corrections_cca_one.json), NOT the DB id and NOT the display name — the
// gen-2 ball notebook keys corrections to videos by stem.
//
// This used to be derived from games.name, which worked only because the name
// happened to be the bundle filename. Names are derived now (NAMING-PLAN.md),
// so the stem comes from games.source_file via buildCorrections instead, and
// the pairing no longer breaks when a game is renamed.
// ?download=1 keeps the old attachment behavior.
export async function GET(req, { params }) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const data = buildCorrections(id);
  if (!data) return Response.json({ error: "no such game" }, { status: 404 });
  const body = JSON.stringify(data, null, 1);
  const file = `corrections_${data.video_stem}.json`;
  let dest = new URL(req.url).searchParams.get("dest");
  // "auto" = best available: Drive when OAuth is configured, else the app
  // folder. Used by the review page's auto-export (ML-PLAN 0.3) so the same
  // request works on any deployment; both destinations upsert by filename,
  // so repeated fires just refresh the file.
  if (dest === "auto") dest = driveCanUpload() ? "drive" : null;

  if (new URL(req.url).searchParams.get("download"))
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${file}"`,
      },
    });

  // straight to the Drive folder (where the gen-2 notebook reads corrections)
  if (dest === "drive") {
    if (!driveCanUpload())
      return Response.json({ error: "Drive upload needs user OAuth (a service " +
        "account can't own files on a personal account) — run npm run drive-auth, " +
        "see DRIVE-SETUP.md" }, { status: 400 });
    try {
      const r = await uploadFile(file, body);
      return Response.json({ ok: true, dest: "drive", file: r.name,
        updated: r.updated, stats: data.review_stats, rallies: data.rallies.length });
    } catch (e) {
      return Response.json({ error: String(e.message || e) }, { status: 500 });
    }
  }

  // default: write into the app folder (same place `npm run export` writes)
  const fp = path.join(process.cwd(), file);
  fs.writeFileSync(fp, body);
  return Response.json({ ok: true, dest: "folder", path: fp, file,
    stats: data.review_stats, rallies: data.rallies.length });
}
