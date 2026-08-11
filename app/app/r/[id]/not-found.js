import NightTheme from "../../theme";

// A dead permalink is the failure a shared link actually hits, so it gets a
// real page rather than the framework default. Both causes are reversible —
// a rally re-cut in review becomes new rows, and a game can be unpublished
// and published again — so the wording promises nothing either way.
export default function RallyNotFound() {
  return (
    <>
      <NightTheme />
      <div className="card rp-gone">
        <h1>That clip isn&apos;t here</h1>
        <p className="muted">
          The link may point at a rally that has since been re-cut, or at a game
          that isn&apos;t published right now. It may be back later.
        </p>
        <a className="abtn" href="/watch">Browse all the games</a>
      </div>
    </>
  );
}
