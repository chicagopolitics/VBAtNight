import { createLoginToken, sendMagicLink } from "@/lib/auth";

export async function POST(req) {
  const { email } = await req.json();
  if (!email || !email.includes("@"))
    return Response.json({ error: "bad email" }, { status: 400 });
  const token = createLoginToken(email);
  const base = process.env.APP_URL || new URL(req.url).origin;
  const r = await sendMagicLink(email, `${base}/api/auth/verify?token=${token}`);
  return Response.json({ ok: true, dev: !!r.dev });
}
