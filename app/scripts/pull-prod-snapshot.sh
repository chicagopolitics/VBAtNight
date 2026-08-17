#!/usr/bin/env bash
# Pull a SANITIZED copy of the production database for local development.
#
#   app/scripts/pull-prod-snapshot.sh [--from-nightly] [--keep-embeddings]
#
# Connects to the ssh host `vbatnight` — define it in ~/.ssh/config, or point
# somewhere else with VBAT_HOST=root@example.com.
#
# The scrub happens ON THE DROPLET, on a temp copy, before anything crosses the
# wire — so no email address or session token ever reaches this machine. That
# ordering is the whole point; sanitizing after the transfer would be theatre.
#
# What it removes:
#   sessions      every row — `token` is a live 90-day credential
#   auth_tokens   every row — magic-link tokens, plus the email they were for
#   page_views    every row — ip_hash + full user-agent, no value here
#   users.email   rewritten to user<id>@example.invalid (column is UNIQUE
#                 NOT NULL, so it has to be rewritten rather than nulled)
#   recaps.email  same; `error` nulled, since provider messages echo addresses
#   identities.embedding  nulled unless --keep-embeddings (appearance
#                 descriptors — large, and nothing local reads them)
#
# What it keeps: names. players.display_name, identities.name, users.name and
# shorts.caption all survive, because the point of a real snapshot is to see
# how a night actually reads. Then VACUUM, or the deleted rows stay perfectly
# readable in the file's freed pages.
#
# It NEVER writes to the live database, never restarts a service, and never
# touches anything on the droplet outside /tmp.
set -euo pipefail

# Bare alias, not user@host: it defers entirely to ~/.ssh/config, so the user
# and the address the droplet actually lives at are yours to change without
# touching this file. Override with VBAT_HOST if the alias isn't defined.
HOST="${VBAT_HOST:-vbatnight}"
FROM_NIGHTLY=0
KEEP_EMBEDDINGS=0

for arg in "$@"; do
  case "$arg" in
    --from-nightly)    FROM_NIGHTLY=1 ;;
    --keep-embeddings) KEEP_EMBEDDINGS=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# repo root = two levels up from this script, so it runs from anywhere
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/app/data/prod-snapshot.db"      # app/data/ is gitignored
REMOTE_TMP="/tmp/vbat-snapshot.$$.db"

cleanup() { ssh "$HOST" "rm -f '$REMOTE_TMP'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "host: $HOST"

# --- 1. snapshot + scrub, entirely on the droplet ---------------------------
# `.backup` is SQLite's online-backup API: it reads the live database and takes
# a consistent copy even while vbatnight.service is writing to it. It does not
# modify the source. --from-nightly uses the cron backup instead, for anyone
# who'd rather the live file not be opened at all.
# Only simple values cross as environment assignments — the SQL is built on the
# far side, so nothing here has to survive a round of shell quoting.
ssh "$HOST" "FROM_NIGHTLY=$FROM_NIGHTLY KEEP_EMBEDDINGS=$KEEP_EMBEDDINGS \
             REMOTE_TMP='$REMOTE_TMP' bash -s" <<'REMOTE'
set -euo pipefail
LIVE_DB="/opt/vbatnight/app/data/balltime.db"
BACKUP_DIR="/opt/backups"
EMB_SQL="UPDATE identities SET embedding = NULL;"
[ "$KEEP_EMBEDDINGS" = 1 ] && EMB_SQL="-- embeddings kept"

if [ "$FROM_NIGHTLY" = 1 ]; then
  src="$(ls -1t "$BACKUP_DIR"/balltime-*.db 2>/dev/null | head -1 || true)"
  [ -n "$src" ] || { echo "no nightly backup in $BACKUP_DIR" >&2; exit 1; }
  echo "source: $src (nightly)"
  cp -- "$src" "$REMOTE_TMP"
else
  [ -f "$LIVE_DB" ] || { echo "no database at $LIVE_DB" >&2; exit 1; }
  echo "source: $LIVE_DB (live, via .backup)"
  sqlite3 "$LIVE_DB" ".backup '$REMOTE_TMP'"
fi

sqlite3 "$REMOTE_TMP" <<SQL
.bail on
PRAGMA foreign_keys = OFF;
DELETE FROM sessions;
DELETE FROM auth_tokens;
DELETE FROM page_views;
UPDATE users  SET email = 'user' || id || '@example.invalid';
UPDATE recaps SET email = 'user' || player_id || '@example.invalid', error = NULL;
$EMB_SQL
VACUUM;
SQL

# --- verify BEFORE the file is allowed to leave the box ---------------------
# A scrub that silently half-applied is the one failure worth guarding twice.
leaks=$(sqlite3 "$REMOTE_TMP" "
  SELECT (SELECT COUNT(*) FROM sessions)
       + (SELECT COUNT(*) FROM auth_tokens)
       + (SELECT COUNT(*) FROM page_views)
       + (SELECT COUNT(*) FROM users  WHERE email NOT LIKE '%@example.invalid')
       + (SELECT COUNT(*) FROM recaps WHERE email NOT LIKE '%@example.invalid');")
if [ "$leaks" != "0" ]; then
  rm -f "$REMOTE_TMP"
  echo "SCRUB FAILED — $leaks row(s) still carry credentials or real addresses." >&2
  echo "Nothing was transferred; the temp copy has been deleted." >&2
  exit 1
fi
echo "scrub verified on the droplet: 0 leaking rows"
REMOTE

# --- 2. transfer ------------------------------------------------------------
mkdir -p "$(dirname "$OUT")"
scp -q "$HOST:$REMOTE_TMP" "$OUT"
echo "wrote $OUT"

# --- 3. verify again, on the file that actually landed ----------------------
node "$ROOT/app/scripts/verify-snapshot.mjs" "$OUT"

echo
echo "run the app against it:  npm --prefix app run dev:snapshot   (port 3001)"
