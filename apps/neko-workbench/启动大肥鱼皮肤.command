#!/bin/zsh
set -e
NEKO_WORKBENCH_DIR="${0:A:h}"
export PET_DSH_SKIN=bigfish
exec "$NEKO_WORKBENCH_DIR/启动工作小队.command" "$@"
