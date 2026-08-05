import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

export default async function Analytics() {
  const user = await getSessionUser();
  if (!isOrganizer(user)) redirect("/watch");

  const d = db();

  // Total views (all time)
  const total = d.prepare("SELECT count(*) AS n FROM page_views").get().n;

  // Unique visitors today (by ip_hash)
  const todayUniq = d.prepare(
    `SELECT count(DISTINCT ip_hash) AS n FROM page_views
     WHERE created_at >= date('now')`).get().n;

  // Views per page (all time)
  const byPage = d.prepare(
    `SELECT path, count(*) AS views, count(DISTINCT ip_hash) AS uniq
     FROM page_views GROUP BY path ORDER BY views DESC`).all();

  // Views per day (last 30 days)
  const byDay = d.prepare(
    `SELECT date(created_at) AS day, count(*) AS views,
            count(DISTINCT ip_hash) AS uniq
     FROM page_views
     WHERE created_at >= date('now', '-30 days')
     GROUP BY day ORDER BY day DESC`).all();

  // Top referrers
  const referrers = d.prepare(
    `SELECT referrer, count(*) AS views FROM page_views
     WHERE referrer IS NOT NULL AND referrer != ''
     GROUP BY referrer ORDER BY views DESC LIMIT 10`).all();

  return (
    <div>
      <h1>Analytics</h1>

      <div className="row" style={{ gap: 20, marginBottom: 20 }}>
        <div className="card" style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{total}</div>
          <div className="muted">Total page views</div>
        </div>
        <div className="card" style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{todayUniq}</div>
          <div className="muted">Unique visitors today</div>
        </div>
      </div>

      <h2>Views by page</h2>
      <table>
        <thead><tr><th style={{ textAlign: "left" }}>Page</th><th>Views</th><th>Unique</th></tr></thead>
        <tbody>
          {byPage.length === 0 && <tr><td colSpan={3} className="muted">No data yet</td></tr>}
          {byPage.map(r => (
            <tr key={r.path}>
              <td>{r.path}</td><td>{r.views}</td><td>{r.uniq}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Last 30 days</h2>
      <table>
        <thead><tr><th style={{ textAlign: "left" }}>Date</th><th>Views</th><th>Unique</th></tr></thead>
        <tbody>
          {byDay.length === 0 && <tr><td colSpan={3} className="muted">No data yet</td></tr>}
          {byDay.map(r => (
            <tr key={r.day}>
              <td>{r.day}</td><td>{r.views}</td><td>{r.uniq}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {referrers.length > 0 && <>
        <h2>Top referrers</h2>
        <table>
          <thead><tr><th style={{ textAlign: "left" }}>Referrer</th><th>Views</th></tr></thead>
          <tbody>
            {referrers.map(r => (
              <tr key={r.referrer}>
                <td style={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis" }}>{r.referrer}</td>
                <td>{r.views}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>}
    </div>
  );
}
