# VBAtNight web app

Next.js + SQLite review UI for the volleyball pipeline.

## Run locally
    npm install
    npm run dev        # http://localhost:3000

(`better-sqlite3` builds automatically; on Node 22+ the app falls back to the
built-in `node:sqlite` if it's unavailable.)

## Import games (the queue)

`/import` queues bundles; **`scripts/import-worker.mjs` does the importing**.
Nothing imports inside a web request, so a batch of six keeps going with the
page closed:

    npm run import-worker -- --watch     # leave this running alongside `npm run dev`

Without a worker running, queued jobs just sit there. In production systemd
runs it (`vbatnight-import`, see `deploy/02-deploy-app.sh`).

Drive bundles are fully server-side. Uploaded files are staged to
`data/staging/` first — an upload still in flight is the one thing a refresh
can lose, because until its bytes land the file exists only in the browser.

## Import a game (CLI)
    npm run import -- path/to/game.json "Game name" [clips_dir] [crops_dir]

- `game.json` — pipeline output (needs `clusters` + `rallies[].contacts`)
- `clips_dir` — per-rally mp4s named `rally_NN_*.mp4` (from pipeline)
- `crops_dir` — player crops referenced by `clusters[].rep_crops`

A demo game (the example league night) is pre-imported in `data/balltime.db`
with media in `public/media/1/`.

## Flow
1. **/** — game list
2. **Name players** — one row per detected identity: name, merge duplicates,
   dismiss non-players
3. **Review plays** — rally clips + touch chips; click a chip to seek video and
   edit type/player; add missed touches at the playhead; deletions are soft.
   All corrections are flagged (`corrected=1`) — future training data.

## Deploy (VPS)
    npm run build && npm start   # behind nginx/caddy; serve /public statically
