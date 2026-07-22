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
mkdir -p "$APP_DIR/app/data" "$APP_DIR/app/public/media" "$APP_DIR/keys" /opt/backups

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
systemctl daemon-reload
systemctl enable --now vbatnight

echo "=== [6/7] Caddy ==="
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy localhost:3000
}
www.$DOMAIN {
    redir https://$DOMAIN{uri} permanent
}
EOF
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
