import { cookies } from "next/headers";
import { db } from "./db";
import crypto from "crypto";

const DAY = 24 * 3600 * 1000;

export async function getSessionUser() {
  const jar = await cookies();
  const tok = jar.get("bt_session")?.value;
  if (!tok) return null;
  const row = db().prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`).get(tok);
  return row ? { ...row } : null;
}

export function isOrganizer(user) {
  if (!user) return false;
  const env = process.env.ORGANIZER_EMAILS;
  if (!env) return true;         // dev default: everyone; set in production!
  return env.split(",").map(s => s.trim().toLowerCase()).includes(user.email.toLowerCase());
}

export function createLoginToken(email) {
  const token = crypto.randomBytes(24).toString("base64url");
  db().prepare(`INSERT INTO auth_tokens (token, email, expires_at)
                VALUES (?, ?, datetime('now', '+15 minutes'))`).run(token, email.toLowerCase());
  return token;
}

export function redeemLoginToken(token) {
  const d = db();
  const row = d.prepare(
    `SELECT * FROM auth_tokens WHERE token = ? AND expires_at > datetime('now')`).get(token);
  if (!row) return null;
  d.prepare("DELETE FROM auth_tokens WHERE token = ?").run(token);
  let user = d.prepare("SELECT * FROM users WHERE email = ?").get(row.email);
  if (!user) {
    const id = d.prepare("INSERT INTO users (email) VALUES (?)").run(row.email).lastInsertRowid;
    user = d.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }
  const sess = crypto.randomBytes(24).toString("base64url");
  d.prepare(`INSERT INTO sessions (token, user_id, expires_at)
             VALUES (?, ?, datetime('now', '+90 days'))`).run(sess, user.id);
  return { session: sess, user: { ...user } };
}

export async function sendMagicLink(email, url) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n*** MAGIC LINK (no RESEND_API_KEY set) for ${email}:\n*** ${url}\n`);
    return { dev: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "VBAtNight <onboarding@resend.dev>",
      to: [email],
      subject: "Your VBAtNight sign-in link",
      text: `Click to sign in: ${url}\n\nThis link expires in 15 minutes.`,
    }),
  });
  if (!res.ok) throw new Error(`resend: ${res.status} ${await res.text()}`);
  return { sent: true };
}
