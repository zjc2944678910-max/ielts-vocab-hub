#!/bin/bash
set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAGE_PORT=8080
PROXY_PORT=8081
PAGE_URL="http://127.0.0.1:${PAGE_PORT}"
PROXY_PID=""
SERVER_PID=""

cd "$PROJECT_DIR" || exit 1

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

proxy_ready() {
  curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" 2>/dev/null | grep -q '"version": 4'
}

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
}
trap cleanup INT TERM EXIT

if port_in_use "$PAGE_PORT"; then
  echo "❌ 页面端口 ${PAGE_PORT} 已被占用。"
  echo "请先关闭旧的 IELTS Vocab Hub 窗口，或运行：lsof -nP -iTCP:${PAGE_PORT} -sTCP:LISTEN"
  exit 1
fi

if port_in_use "$PROXY_PORT"; then
  if proxy_ready; then
    echo "⚠️ IELTS Vocab Hub 代理已在运行，将继续使用。"
  else
    echo "❌ 代理端口 ${PROXY_PORT} 被其他程序占用。"
    echo "请先关闭占用该端口的程序，再重新启动。"
    exit 1
  fi
else
  python3 proxy.py > /tmp/ielts-vocab-proxy.log 2>&1 &
  PROXY_PID=$!
fi

PROXY_READY=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if proxy_ready; then
    PROXY_READY=1
    break
  fi
  sleep 0.2
done

if [ "$PROXY_READY" -ne 1 ]; then
  echo "❌ 本机 AI 代理启动失败。日志：/tmp/ielts-vocab-proxy.log"
  exit 1
fi

python3 -m http.server "$PAGE_PORT" --bind 127.0.0.1 > /tmp/ielts-vocab-page.log 2>&1 &
SERVER_PID=$!

READY=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$PAGE_URL/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done

if [ "$READY" -ne 1 ]; then
  echo "❌ 页面服务启动失败。日志：/tmp/ielts-vocab-page.log"
  exit 1
fi

echo "✅ IELTS Vocab Hub 已启动"
echo "📖 页面地址：$PAGE_URL"
echo "按 Ctrl+C 停止服务"

if [ "${IELTS_VOCAB_NO_OPEN:-0}" != "1" ] && command -v open >/dev/null 2>&1; then
  open "$PAGE_URL"
fi

wait "$SERVER_PID"
