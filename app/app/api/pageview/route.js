import { db } from "@/lib/db";
import { headers } from "next/headers";
import crypto from "crypto";

// Daily salt so IP hashes can't be correlated across days
let salt = "", saltDay = "";
function ipHash(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (saltDay !== today) { salt = crypto.randomBytes(16).toString("hex"); saltDay = today; }
  return crypto.createHash("sha256").update(salt + ip).digest("hex").slice(0, 12);
}

export async function POST(req) {
  try {
    const h = await headers();
    const { path, referrer } = await req.json();
    if (!path || typeof path !== "string") return new Response(null, { status: 204 });
    const ua = h.get("user-agent") || null;
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim()
      || h.get("x-real-ip") || "unknown";
    db().prepare(
      `INSERT INTO page_views (path, referrer, user_agent, ip_hash)
       VALUES (?, ?, ?, ?)`
    ).run(path.slice(0, 500), (referrer || "").slice(0, 1000) || null, ua, ipHash(ip));
  } catch (e) {
    console.error("pageview:", e.message);
  }
  return new Response(null, { status: 204 });
}
