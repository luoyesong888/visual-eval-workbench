#!/usr/bin/env bash
# Start the comparison workbench.
#
#   ./start.sh                      # web on 3000; also starts the scorer if available
#   WEB_PORT=3001 ./start.sh
#   EVAL_SUITE=/path/to/eval-suite ./start.sh
#
# Two processes, one Ctrl-C.
#
# The Python scorer (VBench + pyiqa) is optional: the root page scores with an
# MLLM and needs no local compute at all. Only /advanced uses objective metrics.
# So a missing eval-suite is a warning, not a fatal error - otherwise anyone who
# clones this repo alone could not run it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_SUITE="${EVAL_SUITE:-$HERE/../eval-suite}"
WEB_PORT="${WEB_PORT:-3000}"
SCORE_PORT="${SCORE_PORT:-7861}"

PIDS=()
cleanup() {
  echo
  echo "==> 停止服务"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

if [ ! -x "$HERE/node_modules/.bin/next" ]; then
  echo "node_modules 缺失，先执行： cd \"$HERE\" && npm install"
  exit 1
fi

SCORER_UP=0
if [ -x "$EVAL_SUITE/.venv/bin/python" ] && [ -f "$EVAL_SUITE/upstream/VBench/vbench/__init__.py" ]; then
  echo "==> [1/2] 客观指标服务 :${SCORE_PORT}"
  (
    cd "$EVAL_SUITE"
    exec .venv/bin/python -m uvicorn webapp.score_server:app \
      --host 127.0.0.1 --port "$SCORE_PORT" --log-level warning
  ) &
  PIDS+=($!)

  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "http://127.0.0.1:${SCORE_PORT}/health" 2>/dev/null; then
      echo "    scorer ready"
      SCORER_UP=1
      break
    fi
    sleep 0.5
  done
  [ "$SCORER_UP" = "1" ] || echo "    ! 打分服务未在 20 秒内就绪，/advanced 的客观指标将不可用"
else
  echo "==> [1/2] 跳过客观指标服务"
  echo "    未找到 $EVAL_SUITE/.venv/bin/python"
  echo "    首页的 AI 打分不受影响；/advanced 的 VBench 指标将不可用。"
fi

echo "==> [2/2] 工作台 :${WEB_PORT}"
# NODE_OPTIONS is cleared on purpose: on machines that inject a filesystem
# sandbox hook through it, Next.js cannot create or remove .next/.
(
  cd "$HERE"
  NODE_OPTIONS="" NEXT_TELEMETRY_DISABLED=1 \
    SCORE_SERVICE_URL="http://127.0.0.1:${SCORE_PORT}" \
    exec ./node_modules/.bin/next dev --port "$WEB_PORT"
) &
PIDS+=($!)

cat <<TXT

  横评首页    http://localhost:${WEB_PORT}
  完整工作台  http://localhost:${WEB_PORT}/advanced
$( [ "$SCORER_UP" = "1" ] && echo "  客观指标    http://127.0.0.1:${SCORE_PORT}/health" )

  首页右上角填「裁判模型」（支持视觉的 OpenAI 兼容接口），
  再在模型槽填各家 API Key，点「开始对比」。

TXT

wait
