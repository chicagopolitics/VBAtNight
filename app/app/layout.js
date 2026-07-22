import "./globals.css";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export const metadata = { title: "Balltime" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }) {
  const user = await getSessionUser();
  const org = isOrganizer(user);
  return (
    <html lang="en">
      <body>
        <header className="topbar row" style={{ justifyContent: "space-between" }}>
          <a href="/">🏐 Balltime</a>
          <nav className="row">
            {user && <a href="/watch">Watch</a>}
            {user && <a href="/stats">Stats</a>}
            {org && user && <a href="/">Manage</a>}
            {org && user && <a href="/players">Players</a>}
            {org && user && <a href="/setup">Camera setup</a>}
            {org && user && <a href="/guide">Guide</a>}
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
