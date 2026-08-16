"use client";
import { useEffect, useRef, useState } from "react";
import { copyText } from "@/app/share";

// Pick a night, see exactly who gets mail and why, read one of them, send.
//
// The deliberate friction here is the preview and the send-to-me step: this is
// the only screen on the site that does something you cannot take back, to
// two dozen real people at once.

export default function RecapSender({ days }) {
  const [day, setDay] = useState(days[0]?.day ?? "");
  const [list, setList] = useState(null);      // null = loading
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmRow, setConfirmRow] = useState(null);   // player_id mid-confirm
  // The group blurb. Editable: it's going out under his name into a chat, so
  // the generator's job is to get him 95% of the way, not to have the last
  // word. Reset on every night change — a leftover edit describing Tuesday
  // pasted under Thursday's heading is the one failure that matters.
  const [blurb, setBlurb] = useState("");
  const [copied, setCopied] = useState(null);   // 'ok' | 'fail' | null
  const copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useEffect(() => {
    if (!day) return;
    setList(null); setPreview(null); setDone(null);
    setConfirm(false); setConfirmRow(null);
    setBlurb(""); setCopied(null);
    fetch(`/api/recaps?day=${day}`)
      .then(r => r.json())
      .then(j => {
        setList(j.recipients || []);
        setBlurb(j.summaryText || "");
        setErr(j.error ?? null);
      })
      .catch(e => setErr(e.message));
  }, [day]);

  // Copying IS the interaction here, so the button has to say it worked —
  // a silent success reads as a dead button (same reasoning as ShareButton).
  const copyBlurb = async () => {
    const ok = await copyText(blurb);
    setCopied(ok ? "ok" : "fail");
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  const post = async (payload) => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/recaps", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, ...payload }) });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || `failed (${res.status})`); return null; }
      return j;
    } catch (e) { setErr(e.message); return null; }
    finally { setBusy(false); }
  };

  const refresh = () => fetch(`/api/recaps?day=${day}`).then(r => r.json())
    .then(j => setList(j.recipients || []));

  const showPreview = async (player_id) => {
    const j = await post({ action: "preview", player_id });
    if (j) setPreview(j);
  };

  // One player, one email. The pilot case — and the safe way to try a real
  // send on someone who'll tell you if it reads wrong. Same send path as the
  // bulk button, narrowed by player_ids, so it can't drift from it.
  const sendOne = async (r) => {
    const j = await post({ action: "send", player_ids: [r.player_id] });
    setConfirmRow(null);
    if (!j) return;
    const res = (j.sent || [])[0];
    setDone(!res ? "Nothing sent — already sent, or no stats that night."
      : res.status === "sent" ? `Sent to ${res.email}.`
      : `Failed for ${res.email}: ${res.error}`);
    refresh();
  };

  const pending = (list || []).filter(r => !r.sent);
  const already = (list || []).filter(r => r.sent);

  return (
    <div>
      <h1>Recaps</h1>
      <p className="muted">
        One email per player who was actually filmed that night, linking to
        their own plays and stats. Anyone who registered but wasn&apos;t
        recorded isn&apos;t on this list — that&apos;s deliberate.
      </p>

      <div className="row" style={{ margin: "10px 0" }}>
        <label className="muted" htmlFor="day">Night</label>
        <select id="day" value={day} onChange={e => setDay(e.target.value)}>
          {days.map(x => (
            <option key={x.day} value={x.day}>
              {x.label} ({x.games} game{x.games === 1 ? "" : "s"})
              {x.sent > 0 ? ` · ${x.sent} sent` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* The group post. Above the recipient list because it's what goes out
          first — the chat notification is what makes people open the mail. */}
      {blurb && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>Night summary</b>
            <span className="row" style={{ gap: 6 }}>
              <span className="muted">for the group chat — edit before you post</span>
              <button onClick={copyBlurb} aria-live="polite">
                {copied === "ok" ? "✓ Copied"
                  : copied === "fail" ? "Copy failed" : "Copy summary"}
              </button>
            </span>
          </div>
          <textarea value={blurb} onChange={e => setBlurb(e.target.value)}
            rows={Math.min(24, blurb.split("\n").length + 1)} spellCheck={false}
            style={{ width: "100%", marginTop: 8, resize: "vertical",
              fontFamily: "ui-monospace, monospace", fontSize: 13,
              lineHeight: 1.5 }} />
        </div>
      )}

      {err && <p className="pill bad" style={{ display: "inline-block" }}>{err}</p>}
      {list === null && <p className="muted">Loading…</p>}

      {list && list.length === 0 &&
        <p className="card muted">Nobody linked to a player was filmed that night.</p>}

      {list && list.length > 0 && <>
        <div className="row" style={{ margin: "10px 0" }}>
          <span className="muted">
            {pending.length} to send · {already.length} already sent
          </span>
          {/* per-row Preview replaced the "preview any one" button — choosing
              whose email you're reading is strictly more useful */}
          <button disabled={busy || !pending.length}
            onClick={async () => {
              const j = await post({ action: "send", test: true,
                player_id: pending[0]?.player_id });
              if (j) setDone(j.dev
                ? "No RESEND_API_KEY set — the email was logged to the server console, not sent."
                : `Test sent to ${j.to}.`);
            }}>Send to me only</button>
        </div>

        {preview && (
          <div className="card">
            <div className="muted">To {preview.to} ({preview.player})</div>
            <div><b>{preview.subject}</b></div>
            <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0",
              fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
              {preview.text}</pre>
          </div>
        )}
        {done && <p className="pill good" style={{ display: "inline-block" }}>{done}</p>}

        <div className="tablewrap">
          <table>
            <thead><tr>
              <th style={{ textAlign: "left" }}>Player</th>
              <th style={{ textAlign: "left" }}>Email</th>
              <th>Touches</th>
              <th style={{ textAlign: "left" }}>Recap</th>
              <th style={{ textAlign: "left" }}>Send</th>
            </tr></thead>
            <tbody>
              {list.map(r => (
                <tr key={r.player_id}>
                  <td>{r.display_name}</td>
                  <td style={{ textAlign: "left" }}>{r.email}</td>
                  <td>{r.touches}</td>
                  <td style={{ textAlign: "left" }}>
                    <a href={r.url} target="_blank" rel="noreferrer">/p/{r.slug}/{day}</a>
                  </td>
                  <td style={{ textAlign: "left" }}>
                    {r.sent ? <>
                        <span className={`pill ${r.sent.status === "sent" ? "good" : "bad"}`}>
                          {r.sent.status}
                        </span>{" "}
                        <button disabled={busy} onClick={async () => {
                          await fetch(
                            `/api/recaps?day=${day}&player_id=${r.player_id}`,
                            { method: "DELETE" });
                          refresh();
                        }}>allow resend</button>
                      </>
                    : confirmRow === r.player_id ? <span className="row" style={{ gap: 6 }}>
                        {/* the name, not "this one" — the whole point of a
                            single send is knowing exactly who it reaches */}
                        <span>Email {r.display_name}?</span>
                        <button className="primary" disabled={busy}
                          onClick={() => sendOne(r)}>Yes</button>
                        <button disabled={busy}
                          onClick={() => setConfirmRow(null)}>Cancel</button>
                      </span>
                    : <span className="row" style={{ gap: 6 }}>
                        <button disabled={busy}
                          onClick={() => showPreview(r.player_id)}>Preview</button>
                        <button disabled={busy}
                          onClick={() => { setConfirmRow(r.player_id); setDone(null); }}>
                          Send just this one
                        </button>
                      </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The irreversible one, last and behind a second click. */}
        <div className="row" style={{ marginTop: 16 }}>
          {confirm
            ? <>
                <span>Send {pending.length} email{pending.length === 1 ? "" : "s"}?</span>
                <button className="primary" disabled={busy}
                  onClick={async () => {
                    const j = await post({ action: "send" });
                    setConfirm(false);
                    if (j) {
                      const failed = (j.sent || []).filter(x => x.status === "failed");
                      setDone(`Sent ${(j.sent || []).length - failed.length}`
                        + (failed.length ? `, ${failed.length} failed` : "") + ".");
                      refresh();
                    }
                  }}>Yes, send them</button>
                <button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
              </>
            : <button className="primary" disabled={busy || !pending.length}
                onClick={() => setConfirm(true)}>
                Send {pending.length} recap{pending.length === 1 ? "" : "s"}
              </button>}
        </div>
      </>}
    </div>
  );
}
