// The one place mail leaves this app.
//
// Lifted out of sendMagicLink in lib/auth.js when recaps became a second
// sender. Same reasoning as lib/video-source.js and lib/game-name.js: one door
// per capability, so MAIL_FROM is read once and the dev behaviour can't drift
// between callers.
//
// NO API KEY = NO SEND. It logs instead and reports { dev: true }. That is the
// property the whole verification story leans on: recaps can be exercised end
// to end, ledger rows and all, without a single real email being delivered.

const FROM = () => process.env.MAIL_FROM || "VBAtNight <onboarding@resend.dev>";

/**
 * @returns { sent: true } | { dev: true } — throws only on a real API failure,
 * so a caller sending in a loop can record per-recipient errors and continue.
 */
export async function sendMail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n*** MAIL (no RESEND_API_KEY set) to ${to}\n*** ${subject}\n${text}\n`);
    return { dev: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`resend: ${res.status} ${await res.text()}`);
  return { sent: true };
}
