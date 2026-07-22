import { cookies } from "next/headers";
import { db } from "@/lib/db";

export async function POST() {
  const jar = await cookies();
  const tok = jar.get("bt_session")?.value;
  if (tok) db().prepare("DELETE FROM sessions WHERE token = ?").run(tok);
  const res = new Response(null, { status: 302, headers: { Location: "/login" } });
  res.headers.append("Set-Cookie", "bt_session=; Path=/; Max-Age=0");
  return res;
}
