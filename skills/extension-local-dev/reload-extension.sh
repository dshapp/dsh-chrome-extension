#!/usr/bin/env bash
# 重载 Chrome 扩展:通过 CDP 在扩展上下文执行 chrome.runtime.reload()。
# 前置:Chrome 需以调试端口启动(如 --remote-debugging-port=9222)。
# 用法:EXTENSION_ID=xxx CDP_PORT=9222 ./reload-extension.sh
set -uo pipefail

ID="${EXTENSION_ID:-hjgcllfkbkhmggdopnfhhmaiaedacnpg}"
HOST="${CDP_HOST:-127.0.0.1}"
PORT="${CDP_PORT:-9222}"

WS_URL=$(curl -s --max-time 3 "http://$HOST:$PORT/json" \
  | jq -r --arg id "chrome-extension://$ID" '
      . as $all
      | ([ $all[] | select(.type == "service_worker" and (.url | startswith($id))) | .webSocketDebuggerUrl ][0])
        // ([ $all[] | select(.url | startswith($id)) | .webSocketDebuggerUrl ][0])
        // ""')

if [[ -z "$WS_URL" ]]; then
  echo "✗ 未找到扩展 $ID 的 target(端口 $PORT 未开,或 service worker 休眠:先打开一次 sidepanel 再试)" >&2
  exit 1
fi

WS_URL="$WS_URL" EXTENSION_ID="$ID" node <<'NODE'
const ws = new WebSocket(process.env.WS_URL);
let sent = false;
const t = setTimeout(() => { console.error('✗ 超时'); process.exit(1); }, 8000);
const done = (c) => { clearTimeout(t); ws.close(); process.exit(c); };
ws.onopen = () => {
  sent = true;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
    params: { expression: 'chrome.runtime.reload()', returnByValue: true, awaitPromise: true } }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== 1) return;
  if (m.error) { console.error('✗ ' + JSON.stringify(m.error)); done(1); return; }
  if (m.result && m.result.exceptionDetails) {
    console.error('✗ ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
    done(1); return;
  }
  console.log('✓ 已重载扩展 ' + process.env.EXTENSION_ID);
  done(0);
};
ws.onclose = () => { if (sent) { console.log('✓ 已重载扩展(连接被重载关闭) ' + process.env.EXTENSION_ID); done(0); } else done(1); };
ws.onerror = () => { console.error('✗ WebSocket 连接失败'); done(1); };
NODE
