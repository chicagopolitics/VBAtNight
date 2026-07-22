# Balltime web app

Next.js + SQLite review UI for the volleyball pipeline.

## Run locally
    npm install
    npm run dev        # http://localhost:3000

(`better-sqlite3` builds automatically; on Node 22+ the app falls back to the
built-in `node:sqlite` if it's unavailable.)

## Import a game
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
