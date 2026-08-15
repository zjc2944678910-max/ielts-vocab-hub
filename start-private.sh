#!/bin/bash
set -eu

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRIVATE_CATALOG_PATH="${HOME}/.local/share/ielts-vocab-hub/catalog-private.db"

if [ ! -f "$PRIVATE_CATALOG_PATH" ]; then
  echo "❌ 尚未生成本机私有词库：$PRIVATE_CATALOG_PATH"
  echo "请先运行：python3 scripts/build_private_catalog.py"
  exit 1
fi

export IELTS_VOCAB_CATALOG_PATH="$PRIVATE_CATALOG_PATH"
echo "📚 已启用本机 Oxford 私有词库"
exec "$PROJECT_DIR/start.sh"
