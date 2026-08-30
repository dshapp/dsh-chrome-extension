---
name: extension-local-dev
description: >-
  本地调试 DSH Chrome Bridge 扩展：改完代码重载扩展、打开并调试 sidepanel 页面。
  触发词：重载扩展、reload 扩展、打开 sidepanel、调试 sidepanel、本地 dev。
---

# 本地开发:重载扩展 + 调试 sidepanel

三步：**重载 → 打开 sidepanel → Chrome 控制工具调试**。

## 前置（幂等：端口已开就跳过）

Chrome 需带调试端口启动（默认 9222）。检测到已开就跳过，没开才退出并重启：

```bash
curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 || {
  osascript -e 'quit app "Google Chrome"'
  sleep 2
  open -a "Google Chrome" --args --remote-debugging-port=9222
  for _ in $(seq 1 20); do curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 1; done
}
```

日常开发只跑第 1 步，无需重复前置。

## 1. 重载扩展

```bash
./skills/extension-local-dev/reload-extension.sh
```

输出 `✓ 已重载扩展` 即成功。若报「未找到 target」（service worker 休眠），先打开一次 sidepanel 再跑。
扩展 ID 固定 = `hjgcllfkbkhmggdopnfhhmaiaedacnpg`。

## 2. 打开 sidepanel

```
chrome-extension://hjgcllfkbkhmggdopnfhhmaiaedacnpg/pages/sidepanel/index.html
```

## 3. Chrome 控制工具调试

加载 `chrome` skill，用 `mcp__chrome__*` 工具 navigate / snapshot / get_text / evaluate /
screenshot / network 调试。改完回到第 1 步。
