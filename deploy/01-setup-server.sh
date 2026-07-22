#!/bin/bash
# VBAtNight server setup — part 1 of 2.
# Run as root on a fresh Ubuntu 24.04 droplet:  bash 01-setup-server.sh
set -euo pipefail

echo "=== [1/5] System updates ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq

echo "=== [2/5] Firewall (SSH, HTTP, HTTPS only) ==="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "=== [3/5] Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -yq nodejs build-essential python3 sqlite3

echo "=== [4/5] Caddy (web server, automatic HTTPS) ==="
apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -q
apt-get install -yq caddy

echo "=== [5/5] GitHub deploy key ==="
if [ ! -f /root/.ssh/vbatnight_deploy ]; then
  ssh-keygen -t ed25519 -f /root/.ssh/vbatnight_deploy -N "" -C "vbatnight-server"
fi
cat > /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/vbatnight_deploy
  StrictHostKeyChecking accept-new
EOF

echo
echo "================================================================"
echo "DONE. Now add this deploy key to GitHub:"
echo "  repo -> Settings -> Deploy keys -> Add deploy key"
echo "  (title: vbatnight-server, leave 'Allow write access' UNCHECKED)"
echo "================================================================"
cat /root/.ssh/vbatnight_deploy.pub
echo "================================================================"
echo "Then run:  bash 02-deploy-app.sh"
