#!/bin/zsh
set -e
NEKO_WORKBENCH_DIR="${0:A:h}"
NEKO_WORKBENCH_NODE_BIN="${NEKO_WORKBENCH_NODE:-}"
if [[ -z "$NEKO_WORKBENCH_NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NEKO_WORKBENCH_NODE_BIN="$(command -v node)"
  elif [[ -x /opt/homebrew/bin/node ]]; then
    NEKO_WORKBENCH_NODE_BIN=/opt/homebrew/bin/node
  elif [[ -x /usr/local/bin/node ]]; then
    NEKO_WORKBENCH_NODE_BIN=/usr/local/bin/node
  else
    print '未找到 Node.js 24 或更新版本；请安装 Node.js 后再启动。'
    exit 1
  fi
fi
exec "$NEKO_WORKBENCH_NODE_BIN" "$NEKO_WORKBENCH_DIR/scripts/start.cjs" "$@"
