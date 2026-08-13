import "./globals.css";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export const metadata = { title: "VBAtNight" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }) {
  const user = await getSessionUser();
  const org = isOrganizer(user);
  return (
    <html lang="en">
      <body>
        <header className="topbar row" style={{ justifyContent: "space-between" }}>
          <a href="/" className="brand">
            {/* the hero's moon-ball, cut out and shrunk (public/brand) */}
            <img src="/brand/mark-64.png" alt="" width="26" height="26" />
            VBAtNight
          </a>
          <nav className="row">
            <a href="/watch">Watch</a>
            <a href="/stats">Stats</a>
            {org && user && <a href="/">Manage</a>}
            {org && user && <a href="/players">Players</a>}
            {org && user && <a href="/roster">Roster</a>}
            {org && user && <a href="/setup">Camera setup</a>}
            {org && user && <a href="/guide">Guide</a>}
            {org && user && <a href="/analytics">Analytics</a>}
            {user
              ? <form action="/api/auth/logout" method="POST" style={{ display: "inline" }}>
                  <button type="submit">Sign out</button>
                </form>
              : <a href="/login">Sign in</a>}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
