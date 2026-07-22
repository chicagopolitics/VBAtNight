import { getSessionUser, isOrganizer } from "@/lib/auth";
import { importGameFromZip } from "@/lib/import";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// Bundles can be multi-GB (one clip per rally), so the zip is streamed raw to
// disk. FormData is NOT used: undici buffers the whole multipart body in
// memory and its parser fails on large uploads ("expected CRLF").
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  let tmp;
  try {
    const name = new URL(req.url).searchParams.get("name");
    if (!name || !req.body)
      return Response.json({ error: "missing name or file" }, { status: 400 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btimport-"));
    const zipPath = path.join(tmp, "bundle.zip");
    await pipeline(Readable.fromWeb(req.body), fs.createWriteStream(zipPath));
    const gid = await importGameFromZip(zipPath, tmp, name);
    fs.rmSync(tmp, { recursive: true, force: true });
    return Response.json({ ok: true, game_id: gid });
  } catch (e) {
    console.error("import failed:", e);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
