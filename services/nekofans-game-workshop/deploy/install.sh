#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo '请使用 sudo bash deploy/install.sh 公网IP或域名'; exit 1; fi
game_host=${1:-}
if [[ ! $game_host =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; then echo '请提供公网 IP 或域名，不带协议、端口或路径'; exit 1; fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
app_dir=/opt/nekofans-games
if [[ -d $app_dir && -n $(ls -A "$app_dir") && ! -f $app_dir/.nekofans-game-service ]]; then echo '/opt/nekofans-games 已有其他内容，安装未修改它'; exit 1; fi
if [[ -f /etc/nginx/sites-available/nekofans-games && ! -f $app_dir/.nekofans-game-service ]]; then echo '发现既有同名 Nginx 配置，请先核对'; exit 1; fi
apt-get update
apt-get install -y curl ca-certificates xz-utils nginx
node_version=v24.13.1
case $(uname -m) in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; *) echo '暂不支持该架构'; exit 1;; esac
if [[ ! -x /opt/nekofans-games-node/bin/node ]]; then
  download_dir=$(mktemp -d /tmp/nekofans-node.XXXXXX)
  archive=node-${node_version}-linux-${node_arch}.tar.xz
  curl -fL --retry 3 "https://nodejs.org/dist/${node_version}/${archive}" -o "$download_dir/$archive"
  curl -fL --retry 3 "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
  (cd "$download_dir" && awk -v file="$archive" '$2 == file { print }' SHASUMS256.txt > selected.sha256 && test -s selected.sha256 && sha256sum -c selected.sha256)
  mkdir -p /opt/nekofans-games-node
  tar -xJf "$download_dir/$archive" -C /opt/nekofans-games-node --strip-components=1
fi
id nekofans-games >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin nekofans-games
mkdir -p "$app_dir" /var/lib/nekofans-games
# Explicit source allowlist: installed user data and service configuration are preserved.
for item in server public examples scripts deploy package.json package-lock.json; do cp -R "$source_dir/$item" "$app_dir/"; done
touch "$app_dir/.nekofans-game-service"
export PATH="/opt/nekofans-games-node/bin:$PATH"
(cd "$app_dir" && npm ci --omit=dev --no-audit --no-fund)
if [[ ! -f /etc/nekofans-games.env ]]; then
  publish_key=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
  umask 077
  cat > /etc/nekofans-games.env <<EOF
HOST=127.0.0.1
PORT=3088
PUBLIC_ORIGIN=http://${game_host}
DATA_DIR=/var/lib/nekofans-games
PUBLISH_KEY=${publish_key}
ENABLE_DEMO=1
EOF
fi
chmod 600 /etc/nekofans-games.env
chown -R nekofans-games:nekofans-games /var/lib/nekofans-games
cp "$source_dir/deploy/nekofans-games.service" /etc/systemd/system/nekofans-games.service
cat > /etc/nginx/sites-available/nekofans-games <<EOF
server {
  listen 80;
  server_name ${game_host};
  client_max_body_size 650k;
  location / {
    proxy_pass http://127.0.0.1:3088;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 60s;
  }
}
EOF
ln -sfn /etc/nginx/sites-available/nekofans-games /etc/nginx/sites-enabled/nekofans-games
nginx -t
systemctl daemon-reload
systemctl enable --now nekofans-games
systemctl restart nekofans-games
systemctl reload nginx
curl -fsS http://127.0.0.1:3088/healthz
echo
echo "测试入口：http://${game_host}"
echo '发布凭证位于 /etc/nekofans-games.env 的 PUBLISH_KEY 项；请仅由服主管理。'
echo '域名解析完成后，按 README 启用 HTTPS，再交付公开使用。'
