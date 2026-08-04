// Opts a route into the night theme.
//
// The palette swap in globals.css keys off `body:has(.night)`, so a route
// joins the public, night-themed side of the site simply by rendering this
// marker anywhere inside it. Two reasons it's a marker rather than a class on
// <body>:
//
//   1. The root layout is a server component with no access to the pathname,
//      and the alternative — a client component reading usePathname just to
//      pick a skin — would push a boundary around the whole app.
//   2. The topbar lives in the root layout. Because :has() looks at the whole
//      body, the header goes dark on public pages and stays light on the
//      admin ones without the header knowing anything about routes.
//
// Admin routes (/, /import, /games/*, /players, /setup, /guide) render no
// marker and keep the light theme.
export default function NightTheme() {
  return <div className="night" hidden aria-hidden="true" />;
}
