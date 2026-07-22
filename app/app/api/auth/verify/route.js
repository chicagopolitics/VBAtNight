import { redeemLoginToken } from "@/lib/auth";

export async function GET(req) {
  const token = new URL(req.url).searchParams.get("token");
  const r = token && redeemLoginToken(token);
  if (!r) return new Response("Link expired or invalid. Request a new one at /login.",
    { status: 400 });
  const res = new Response(null, { status: 302, headers: { Location: "/" } });
  res.headers.append("Set-Cookie",
    `bt_session=${r.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${90*24*3600}`);
  return res;
}
