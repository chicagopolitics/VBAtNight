import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { LEAGUE_TZ } from "@/lib/luma";
import { RANGES, resolveRange, rangeStart, localShift } from "@/lib/timeframe";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

// "3 PM" from SQLite's zero-padded '%H'
const hourLabel = h => {
  const n = +h;
  return `${n % 12 === 0 ? 12 : n % 12} ${n < 12 ? "AM" : "PM"}`;
};

export default async function Analytics({ searchParams }) {
  const user = await getSessionUser();
  if (!isOrganizer(user)) redirect("/watch");

  const d = db();

  // The timeframe is a URL, not component state — it survives a refresh and a
  // reload keeps the numbers you were looking at (same call as ?day= on /stats).
  const range = resolveRange((await searchParams)?.range);
  const since = rangeStart(range.key);
  const shift = localShift();

  // One seam for every board below: the range becomes a predicate on
  // created_at, and all time is simply the absence of one.
  const where = since ? "WHERE created_at >= ?" : "";
  const and = since ? "AND created_at >= ?" : "";
  const args = since ? [since] : [];

  const totals = d.prepare(
    `SELECT count(*) AS views, count(DISTINCT ip_hash) AS uniq
     FROM page_views ${where}`).get(...args);

  // all-time stays on screen at every range: it's the context that says
  // whether a quiet week is quiet or the site is quiet
  const allTime = d.prepare("SELECT count(*) AS n FROM page_views").get().n;

  const byPage = d.prepare(
    `SELECT path, count(*) AS views, count(DISTINCT ip_hash) AS uniq
     FROM page_views ${where} GROUP BY path ORDER BY views DESC`).all(...args);

  // Today's traffic in daily buckets is one row, which the card above already
  // says — so today breaks down by hour instead, and every other range by day.
  const byHour = range.key !== "today" ? [] : d.prepare(
    `SELECT strftime('%H', created_at, ?) AS hour, count(*) AS views,
            count(DISTINCT ip_hash) AS uniq
     FROM page_views ${where} GROUP BY hour ORDER BY hour DESC`).all(shift, ...args);

  // capped so all-time can't grow into an unreadable wall of rows
  const byDay = range.key === "today" ? [] : d.prepare(
    `SELECT date(created_at, ?) AS day, count(*) AS views,
            count(DISTINCT ip_hash) AS uniq
     FROM page_views ${where} GROUP BY day ORDER BY day DESC LIMIT 90`)
    .all(shift, ...args);

  const referrers = d.prepare(
    `SELECT referrer, count(*) AS views FROM page_views
     WHERE referrer IS NOT NULL AND referrer != '' ${and}
     GROUP BY referrer ORDER BY views DESC LIMIT 10`).all(...args);

  const scope = range.label.toLowerCase();

  return (
    <div>
      <h1>Analytics</h1>

      <div className="tabs">
        {RANGES.map(r => (
          <a key={r.key} href={`/analytics?range=${r.key}`}
            className={"abtn" + (r.key === range.key ? " on" : "")}
            aria-current={r.key === range.key ? "page" : undefined}>
            {r.label}
          </a>
        ))}
      </div>

      <div className="row" style={{ gap: 20, marginBottom: 20 }}>
        <div className="card" style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{totals.views}</div>
          <div className="muted">Page views · {scope}</div>
          {range.key !== "all" &&
            <div className="muted" style={{ fontSize: 12 }}>{allTime} all time</div>}
        </div>
        <div className="card" style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{totals.uniq}</div>
          <div className="muted">Unique visitors · {scope}</div>
        </div>
      </div>

      <h2>Views by page</h2>
      <table>
        <thead><tr><th style={{ textAlign: "left" }}>Page</th><th>Views</th><th>Unique</th></tr></thead>
        <tbody>
          {byPage.length === 0 && <tr><td colSpan={3} className="muted">No views {scope}</td></tr>}
          {byPage.map(r => (
            <tr key={r.path}>
              <td>{r.path}</td><td>{r.views}</td><td>{r.uniq}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {range.key === "today" ? <>
        <h2>By hour</h2>
        <table>
          <thead><tr><th style={{ textAlign: "left" }}>Hour</th><th>Views</th><th>Unique</th></tr></thead>
          <tbody>
            {byHour.length === 0 && <tr><td colSpan={3} className="muted">No views yet today</td></tr>}
            {byHour.map(r => (
              <tr key={r.hour}>
                <td>{hourLabel(r.hour)}</td><td>{r.views}</td><td>{r.uniq}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </> : <>
        <h2>By day</h2>
        <table>
          <thead><tr><th style={{ textAlign: "left" }}>Date</th><th>Views</th><th>Unique</th></tr></thead>
          <tbody>
            {byDay.length === 0 && <tr><td colSpan={3} className="muted">No views {scope}</td></tr>}
            {byDay.map(r => (
              <tr key={r.day}>
                <td>{r.day}</td><td>{r.views}</td><td>{r.uniq}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {byDay.length === 90 &&
          <p className="muted">Showing the 90 most recent days.</p>}
      </>}

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

      <p className="muted">Days and hours are {LEAGUE_TZ.split("/").pop().replace(/_/g, " ")} time.</p>
    </div>
  );
}
