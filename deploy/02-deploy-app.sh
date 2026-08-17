#!/bin/bash
# VBAtNight server setup — part 2 of 2.
# Run as root AFTER adding the deploy key to GitHub:  bash 02-deploy-app.sh
set -euo pipefail

DOMAIN="vbatnight.com"
APP_DIR="/opt/vbatnight"
ORGANIZERS="christianson.general@gmail.com"

echo "=== [1/7] DNS sanity check ==="
MYIP=$(curl -4 -s ifconfig.me)
DNSIP=$(dig +short "$DOMAIN" @1.1.1.1 | tail -1)
echo "server IP: $MYIP   |   $DOMAIN resolves to: ${DNSIP:-<nothing>}"
if [ "$MYIP" != "$DNSIP" ]; then
  echo "WARNING: DNS doesn't point here (yet). HTTPS certs will fail until it does."
  echo "Continuing anyway — Caddy retries automatically once DNS propagates."
fi

echo "=== [2/7] Clone repo ==="
if [ ! -d "$APP_DIR" ]; then
  git clone git@github.com:chicagopolitics/VBAtNight.git "$APP_DIR"
else
  git -C "$APP_DIR" pull
fi

echo "=== [3/7] Install deps + build ==="
cd "$APP_DIR/app"
npm ci --no-audit --no-fund
npm run build

echo "=== [4/7] Environment ==="
if [ ! -f "$APP_DIR/app/.env.local" ]; then
  cat > "$APP_DIR/app/.env.local" <<EOF
ORGANIZER_EMAILS=$ORGANIZERS
# --- fill these in when ready (then: systemctl restart vbatnight) ---
# RESEND_API_KEY=re_...
# MAIL_FROM="VBAtNight <login@vbatnight.com>"
# GOOGLE_SA_KEY=/opt/vbatnight/keys/drive-sa.json
# DRIVE_FOLDER_ID=...
EOF
  echo "wrote $APP_DIR/app/.env.local (edit to add Resend/Drive keys)"
fi
# data/staging holds uploaded bundles between the browser finishing its upload
# and the import worker consuming them. Under data/ on purpose: these are
# multi-GB and must never be reachable through /media, and /tmp would empty on
# reboot while the import_jobs rows pointing at them survived.
mkdir -p "$APP_DIR/app/data" "$APP_DIR/app/data/staging" \
         "$APP_DIR/app/public/media" "$APP_DIR/keys" /opt/backups

echo "=== [5/7] App user + systemd service ==="
id -u vbat &>/dev/null || useradd -r -s /usr/sbin/nologin vbat
chown -R vbat:vbat "$APP_DIR"
cat > /etc/systemd/system/vbatnight.service <<EOF
[Unit]
Description=VBAtNight (Next.js)
After=network.target

[Service]
Type=simple
User=vbat
WorkingDirectory=$APP_DIR/app
ExecStart=/usr/bin/npx next start -p 3000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Shorts render worker. Separate service because a render is 1-2 minutes of
# ffmpeg + OpenCV and must not run inside a web request. Nice'd so it can't
# make the site sluggish while it works — a Short being ready two minutes
# later is fine; a laggy page is not.
cat > /etc/systemd/system/vbatnight-shorts.service <<EOF
[Unit]
Description=VBAtNight Shorts renderer
After=network.target

[Service]
Type=simple
User=vbat
WorkingDirectory=$APP_DIR/app
Environment=SHORTS_PYTHON=/opt/vbatnight-shorts/bin/python
Environment=PIPELINE_DIR=$APP_DIR/pipeline
ExecStart=/usr/bin/node scripts/shorts-worker.mjs --watch
Nice=10
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Bundle import worker. Same reasoning as the Shorts service: importing a
# bundle is minutes of downloading a multi-GB zip from Drive, unzipping it and
# moving video into public/media, which no web request can hold. Having it here
# rather than in the request is also what makes a queue of six survive the
# organizer closing the tab.
cat > /etc/systemd/system/vbatnight-import.service <<EOF
[Unit]
Description=VBAtNight bundle importer
After=network.target

[Service]
Type=simple
User=vbat
WorkingDirectory=$APP_DIR/app
ExecStart=/usr/bin/node scripts/import-worker.mjs --watch
Nice=10
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Shorts publish worker. Third service rather than a branch inside the render
# worker: that one is single-threaded because of ffmpeg and caps a job at 15
# minutes, while this is network-bound. Sharing a loop would let "Publish all"
# sit dead behind one slow render, which is exactly what /shorts exists to
# stop. NOT nice'd — someone is watching the page while this runs.
cat > /etc/systemd/system/vbatnight-publish.service <<EOF
[Unit]
Description=VBAtNight Shorts publisher
After=network.target

[Service]
Type=simple
User=vbat
WorkingDirectory=$APP_DIR/app
ExecStart=/usr/bin/node scripts/publish-worker.mjs --watch
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now vbatnight
systemctl enable --now vbatnight-shorts
systemctl enable --now vbatnight-import
systemctl enable --now vbatnight-publish

echo "=== [6/7] Caddy ==="
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    # /media served by Caddy, not Next: next start only serves public/ files
    # that existed at BUILD time, so game media imported later would 404.
    # Caddy also gives proper Range support for multi-GB rally videos.
    # game.json sits in /media so the Shorts renderer can find it, but it's
    # internal pipeline output (~9 MB of tracks and embeddings), not content.
    # Must come before the file_server handler to win.
    handle /media/*/game.json {
        respond 404
    }
    handle /media/* {
        root * $APP_DIR/app/public
        file_server
    }
    # Brand assets, here for the same two reasons as /media: the hero is an
    # autoplaying <video> now, and iOS Safari won't play one at all unless the
    # server answers Range requests. Next also serves public/ with max-age=0,
    # which means re-fetching 1.4 MB of hero on every cold load. Caddy fixes
    # both. immutable is safe only because these names never change contents —
    # a new hero needs a NEW FILENAME (hero-v2.mp4), not an overwrite.
    handle /brand/* {
        root * $APP_DIR/app/public
        file_server
        header Cache-Control "public, max-age=31536000, immutable"
    }
    reverse_proxy localhost:3000
}
www.$DOMAIN {
    redir https://$DOMAIN{uri} permanent
}
EOF
# media must be world-readable for the caddy user (it's public content).
#
# u+w is not decoration: reclaiming a game's local mp4 (YouTube ▾ → Reclaim)
# unlinks a file, and unlink permission comes from the DIRECTORY's write bit,
# not the file's. A media folder that ends up mode 555 is silently
# un-reclaimable — the disk saving the whole YouTube migration exists for
# stops working, and only for the games that happen to be affected. Making
# the deploy re-assert it means the state self-heals instead of needing to be
# diagnosed from an EACCES.
chmod -R u+w,a+rX "$APP_DIR/app/public/media" 2>/dev/null || true
systemctl reload caddy

echo "=== [7/7] Nightly DB backup (3am, keeps 14 days) ==="
cat > /etc/cron.daily/vbatnight-backup <<'EOF'
#!/bin/bash
sqlite3 /opt/vbatnight/app/data/balltime.db \
  ".backup /opt/backups/balltime-$(date +%F).db"
find /opt/backups -name 'balltime-*.db' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/vbatnight-backup

echo
echo "================================================================"
echo "DONE. Service status:"
systemctl --no-pager -l status vbatnight | head -5
echo
echo "Next: upload your data from your PC (see DEPLOY-CHECKLIST.md),"
echo "then:  chown -R vbat:vbat /opt/vbatnight && systemctl restart vbatnight"
echo "Site:  https://$DOMAIN"
echo "================================================================"
