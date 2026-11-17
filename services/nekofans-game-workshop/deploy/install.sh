#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo '请使用 sudo bash deploy/install.sh 公网IP或域名'; exit 1; fi
game_host=${1:-}
mode=${2:-}
if [[ ! $game_host =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ || ( -n $mode && $mode != --production ) || $# -gt 2 ]]; then echo '用法：sudo bash deploy/install.sh 公网IP或域名 [--production]'; exit 1; fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
app_dir=/opt/nekofans-games
env_file=/etc/nekofans-games.env
nginx_site=/etc/nginx/sites-available/nekofans-games
cleanup() {
  if [[ -n ${download_dir:-} ]]; then rm -rf -- "$download_dir"; fi
  if [[ -n ${validation_dir:-} ]]; then rm -rf -- "$validation_dir"; fi
}
trap cleanup EXIT
if [[ $mode == --production ]]; then
  [[ -f $env_file ]] || { echo '请先按 README 配置正式环境与社区公钥'; exit 1; }
  for certificate in fullchain.pem privkey.pem; do
    [[ -s /etc/letsencrypt/live/$game_host/$certificate ]] || { echo "缺少 ${game_host} 的 HTTPS 证书"; exit 1; }
  done
  if [[ -f $nginx_site ]] && { ! grep -Fq 'proxy_set_header X-Nekofans-Client-IP $remote_addr;' "$nginx_site" || ! grep -Fq 'listen 443 ssl;' "$nginx_site"; }; then
    echo '请按 README 核对既有站点的 HTTPS 与反向代理配置，已有文件未修改'; exit 1
  fi
elif [[ -f $env_file ]] && grep -Eq '^NEKO_WORKSHOP_PRODUCTION=1[[:space:]]*$' "$env_file"; then
  echo '正式站点升级须带 --production'; exit 1
fi
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
export PATH="/opt/nekofans-games-node/bin:$PATH"
if [[ $mode == --production ]]; then
  # Check the pending release from a temporary directory before replacing the service.
  validation_dir=$(mktemp -d /tmp/nekofans-build.XXXXXX)
  cp -R "$source_dir/server" "$source_dir/package.json" "$source_dir/package-lock.json" "$validation_dir/"
  (cd "$validation_dir" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  env -i PATH="$PATH" node --env-file="$env_file" "$validation_dir/server/index.mjs" --check-production-config "$game_host"
fi
id nekofans-games >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin nekofans-games
mkdir -p "$app_dir" /var/lib/nekofans-games
# Explicit source allowlist: installed user data and service configuration are preserved.
for item in server public examples scripts deploy package.json package-lock.json; do cp -R "$source_dir/$item" "$app_dir/"; done
touch "$app_dir/.nekofans-game-service"
(cd "$app_dir" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
if [[ ! -f $env_file ]]; then
  publish_key=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
  umask 077
  cat > "$env_file" <<EOF
HOST=127.0.0.1
PORT=3088
PUBLIC_ORIGIN=http://${game_host}
DATA_DIR=/var/lib/nekofans-games
PUBLISH_KEY=${publish_key}
ENABLE_DEMO=1
EOF
fi
chmod 600 "$env_file"
chown -R nekofans-games:nekofans-games /var/lib/nekofans-games
cp "$source_dir/deploy/nekofans-games.service" /etc/systemd/system/nekofans-games.service
# Certificate tooling may have added HTTPS and redirects to this file.
# Keep the existing virtual host on upgrades.
if [[ ! -f $nginx_site && $mode == --production ]]; then
  sed "s/WORKSHOP_DOMAIN/$game_host/g" "$source_dir/deploy/nginx-production.conf" > "$nginx_site"
elif [[ ! -f $nginx_site ]]; then
  cat > "$nginx_site" <<EOF
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
fi
ln -sfn "$nginx_site" /etc/nginx/sites-enabled/nekofans-games
nginx -t
systemctl daemon-reload
systemctl enable nekofans-games
systemctl restart nekofans-games
curl -fsS --retry 8 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:3088/healthz
systemctl reload nginx
echo
if [[ $mode == --production ]]; then
  echo "工坊入口：https://${game_host}"
  echo '下一步：用两个真实社区账号验证授权、发布和同局。'
else
  echo "测试入口：http://${game_host}"
  echo '发布凭证位于 /etc/nekofans-games.env 的 PUBLISH_KEY 项；请仅由服主管理。'
fi
