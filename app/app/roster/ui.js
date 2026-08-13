"use client";
import { useMemo, useState } from "react";
import { parseRoster, matchRoster, REASONS } from "@/lib/roster";

// Paste the Luma export, confirm the matches. Matching runs here rather than
// on the server because lib/roster.js needs no DB — so the preview updates as
// you type and the only thing that crosses the wire is a decision.

const TONE = { linked: "good", exact: "good", typo: "info", "first-name": "info",
  claimed: "bad", ambiguous: "", none: "" };

export default function RosterImport({ players, links: initialLinks }) {
  const [text, setText] = useState("");
  const [links, setLinks] = useState(initialLinks);   // email -> player_id
  const [picks, setPicks] = useState({});             // email -> override
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const parsed = useMemo(() => parseRoster(text), [text]);
  // links is a dependency on purpose: saving one row re-runs the match, which
  // flips it to `linked` and takes its player out of contention for the rest
  const rows = useMemo(() => matchRoster(parsed.rows, players, links),
    [parsed, players, links]);

  const byId = id => players.find(p => p.id === id);
  const pickFor = r => picks[r.email] ?? r.player_id ?? "";
  const pending = rows.filter(r => r.reason !== "linked");
  const readyExact = pending.filter(r => r.reason === "exact" && pickFor(r));

  async function save(batch) {
    if (!batch.length) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/roster", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links: batch.map(r => ({
          email: r.email, name: r.name, player_id: +pickFor(r) })) }) });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || `save failed (${res.status})`); return; }
      setLinks(l => ({ ...l,
        ...Object.fromEntries(j.saved.map(s => [s.email, s.player_id])) }));
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function unlink(email) {
    setBusy(true); setErr(null);
    try {
      await fetch("/api/roster", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlink", email }) });
      setLinks(l => { const n = { ...l }; delete n[email]; return n; });
      setPicks(p => { const n = { ...p }; delete n[email]; return n; });
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h1>Roster</h1>
      <p className="muted">
        Paste the guest export from Luma (CSV or straight out of a spreadsheet).
        Every match below is a suggestion — nothing is saved until you confirm
        it. Linking an email here doesn&apos;t email anyone or change anything
        public; it only records which player that person is.
      </p>

      <textarea value={text} onChange={e => setText(e.target.value)}
        placeholder="name,email&#10;Michael Smith,mike@example.com"
        rows={6} spellCheck={false}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace",
          fontSize: 13, background: "var(--surface)", color: "var(--ink)",
          border: "1px solid var(--border-2)", borderRadius: 6, padding: 10 }} />

      {text.trim() && parsed.rows.length === 0 &&
        <p className="muted">
          Couldn&apos;t find an email column in that. Paste needs a header row
          (or at least one column of email addresses).
        </p>}

      {parsed.rows.length > 0 && <>
        <div className="row" style={{ margin: "10px 0" }}>
          <span className="muted">
            {parsed.rows.length} registrant{parsed.rows.length === 1 ? "" : "s"}
            {parsed.skipped > 0 && ` · ${parsed.skipped} row(s) skipped`}
            {" · "}{rows.length - pending.length} already linked
          </span>
          <button className="primary" disabled={busy || !readyExact.length}
            onClick={() => save(readyExact)}>
            Link {readyExact.length} exact match{readyExact.length === 1 ? "" : "es"}
          </button>
        </div>

        {err && <p className="pill bad" style={{ display: "inline-block" }}>{err}</p>}

        <div className="tablewrap">
          <table>
            <thead><tr>
              <th style={{ textAlign: "left" }}>Registered as</th>
              <th style={{ textAlign: "left" }}>Email</th>
              <th style={{ textAlign: "left" }}>Match</th>
              <th style={{ textAlign: "left" }}>Player</th>
              <th></th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const linked = r.reason === "linked";
                const pick = pickFor(r);
                return (
                  <tr key={r.email}>
                    <td>{r.name || <span className="muted">(no name)</span>}</td>
                    <td style={{ textAlign: "left" }}>{r.email}</td>
                    <td style={{ textAlign: "left" }}>
                      <span className={`pill ${TONE[r.reason] || ""}`}>
                        {REASONS[r.reason]}
                      </span>
                    </td>
                    <td style={{ textAlign: "left" }}>
                      {linked
                        ? byId(r.player_id)?.display_name ?? `#${r.player_id}`
                        : <select value={pick} disabled={busy}
                            onChange={e => setPicks(p => ({ ...p, [r.email]: e.target.value }))}>
                            <option value="">— skip —</option>
                            {/* candidates first: for an ambiguous row they're
                                the whole question, and for the rest they save
                                a scroll through the full registry */}
                            {r.candidates.length > 0 && <optgroup label="Suggested">
                              {r.candidates.map(id => (
                                <option key={id} value={id}>
                                  {byId(id)?.display_name} ({byId(id)?.games} games)
                                </option>))}
                            </optgroup>}
                            <optgroup label="All players">
                              {players.map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.display_name} ({p.games} games)
                                </option>))}
                            </optgroup>
                          </select>}
                    </td>
                    <td>
                      {linked
                        ? <button disabled={busy} onClick={() => unlink(r.email)}>Unlink</button>
                        : <button className="primary" disabled={busy || !pick}
                            onClick={() => save([r])}>Link</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}

      <p className="muted" style={{ marginTop: 16 }}>
        A registrant with no matching player is normal — they signed up but
        didn&apos;t play, or they played and weren&apos;t detected. Leave those
        skipped. Names come from <a href="/players">Players</a>.
      </p>
    </div>
  );
}
