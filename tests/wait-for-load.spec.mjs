/**
 * waitForLoad() 的收敛保证。
 *
 * 它靠 chrome.tabs.get 补一次"当前页是否已经加载完"的检查,好让一个本来就
 * 已 complete 的页面不必等 onUpdated 事件。这个 promise 有两种失败方式:
 * get 返回的 status 不是 complete(正常,等事件),以及 get 本身 reject
 * ——标签页在等待期间被用户关掉了。
 *
 * 后者必须自己收敛:MV3 service worker 里未处理的 promise rejection 会污染
 * 整个 worker,而 onUpdated 也永远不会再来通知一个不存在的标签页,于是调用方
 * 白等满整个超时(实测 15s)才失败。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')

/** chrome 环境最小桩:background.js 顶层会注册监听,waitForLoad 只用这两个。 */
function loadWorker({ onGet }) {
  const listeners = []
  const handler = { addListener() {}, removeListener() {} }
  const chrome = {
    runtime: { id: 'test', getManifest: () => ({ version: '0' }), getPlatformInfo: async () => ({ os: 'mac' }),
      onMessage: handler, onStartup: handler, onInstalled: handler },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: handler },
    alarms: { create() {}, onAlarm: handler },
    tabs: {
      get: onGet,
      query: async () => [],
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      remove: async () => {},
      group: async () => 1,
      onUpdated: {
        addListener(fn) { listeners.push(fn) },
        removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) },
      },
      onRemoved: handler,
    },
    tabGroups: { get: async () => ({}), update: async () => {} },
    windows: { update: async () => {} },
    debugger: {
      attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}),
      onDetach: handler, onEvent: handler,
    },
  }
  // Source is a classic script: returning internals keeps the test on the real
  // function rather than a copy of it.
  const internals = new Function('chrome', 'WebSocket', 'console', `${source}\n;return { waitForLoad };`)
  const WebSocketStub = class { constructor() {} addEventListener() {} send() {} close() {} }
  return { waitForLoad: internals(chrome, WebSocketStub, console).waitForLoad, listeners }
}

test('waitForLoad:标签页在等待期间消失时立即收敛,且不产生未处理的 rejection', async () => {
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const { waitForLoad, listeners } = loadWorker({
      onGet: async (id) => { throw new Error(`No tab with id: ${id}`) },
    })
    const started = Date.now()
    // timeoutMs 放大到 3s:若靠超时兜底,耗时就能和"立即收敛"区分开。
    await waitForLoad(900, 3000)
    const elapsed = Date.now() - started
    // 给 rejection 的微任务一个落点。
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(unhandled.length, 0, `不应有未处理的 rejection:${unhandled.map(String).join('; ')}`)
    assert.ok(elapsed < 500, `标签页已消失就该立即收敛,不该等满超时(实测 ${elapsed}ms)`)
    assert.equal(listeners.length, 0, '收敛后必须摘掉 onUpdated 监听')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('waitForLoad:页面已是 complete 时正常立刻返回', async () => {
  const { waitForLoad } = loadWorker({ onGet: async () => ({ status: 'complete' }) })
  const started = Date.now()
  await waitForLoad(901, 3000)
  assert.ok(Date.now() - started < 500, '已 complete 的页面不该等超时')
})
