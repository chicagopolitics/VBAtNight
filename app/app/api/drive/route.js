import { getSessionUser, isOrganizer } from "@/lib/auth";
import { driveConfigured, listBundles, downloadFile } from "@/lib/drive";
import { importGameFromZip } from "@/lib/import";
import fs from "fs";
import os from "os";
import path from "path";

// GET: list bundle zips in the shared Drive folder
export async function GET() {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  if (!driveConfigured()) return Response.json({ configured: false, files: [] });
  try {
    return Response.json({ configured: true, files: await listBundles() });
  } catch (e) {
    return Response.json({ configured: true, error: String(e.message || e) },
      { status: 500 });
  }
}

// POST { id, name }: stream the bundle from Drive and import it
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  let tmp;
  try {
    const { id, name } = await req.json();
    if (!id || !name)
      return Response.json({ error: "missing id or name" }, { status: 400 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btimport-"));
    const zipPath = path.join(tmp, "bundle.zip");
    await downloadFile(id, zipPath);
    const gid = await importGameFromZip(zipPath, tmp, name);
    fs.rmSync(tmp, { recursive: true, force: true });
    // NB: bundles are intentionally LEFT in Drive — the gen-2 ball notebook
    // re-detects each game's video from its bundle, so it needs them to
    // stay in Drive/balltime/bundles. Clear old bundles manually when done.
    return Response.json({ ok: true, game_id: gid });
  } catch (e) {
    console.error("drive import failed:", e);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
