"use client";
import { useState } from "react";

export default function Login() {
  const [sent, setSent] = useState(false);
  const [dev, setDev] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const email = new FormData(e.target).get("email");
    const res = await fetch("/api/auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) { setErr("Something went wrong — try again."); return; }
    const j = await res.json();
    setDev(!!j.dev); setSent(true);
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: "60px auto" }}>
      <h1>Sign in</h1>
      {sent ? (
        <p>Check your email for a sign-in link.{dev &&
          <span className="muted"><br />(Dev mode: link printed to the server console.)</span>}</p>
      ) : (
        <form onSubmit={submit} className="row">
          <input type="email" name="email" placeholder="you@example.com"
            style={{ flex: 1 }} required suppressHydrationWarning />
          <button className="primary" type="submit">Send link</button>
          {err && <p className="muted">{err}</p>}
        </form>
      )}
    </div>
  );
}
