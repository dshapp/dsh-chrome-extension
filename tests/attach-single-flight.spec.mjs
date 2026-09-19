/**
 * attach() 的并发安全。
 *
 * runToolCall 不被 await(background.js handleFrame),所以两个工具调用可以同时在
 * 一趟事件循环里跑。attach() 原本先查 attached 集合、再 await chrome.debugger.attach,
 * 集合直到 await 之后才更新 —— 两个并发调用会双双穿过守卫,第二个被 Chrome 以
 * "Another debugger is already attached" 拒绝。调用方收到的是一个本不该出现的失败,
 * 尽管调试器其实已经挂上了。
 *
 * attach() 必须单飞:同一标签页的并发调用共享同一个 in-flight promise,
 * 且失败后这个 promise 必须被清掉,否则一次失败会永久毒化该标签页的重试。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')

/** chrome 环境最小桩;debugger 可覆写以驱动 attach 的成败。 */
function loadWorker({ debugger: debuggerOverride } = {}) {
  const handler = { addListener() {}, removeListener() {} }
  const chrome = {
    runtime: { id: 'test', getManifest: () => ({ version: '0' }), getPlatformInfo: async () => ({ os: 'mac' }),
      onMessage: handler, onStartup: handler, onInstalled: handler },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: handler },
    alarms: { create() {}, onAlarm: handler },
    tabs: {
      get: async () => ({ status: 'complete' }), query: async () => [], create: async () => ({ id: 1 }),
      update: async () => ({}), remove: async () => {}, group: async () => 1,
      onUpdated: handler, onRemoved: handler,
    },
    tabGroups: { get: async () => ({}), update: async () => {} },
    windows: { update: async () => {} },
    debugger: debuggerOverride ?? {
      attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}),
      onDetach: handler, onEvent: handler,
    },
  }
  // Source is a classic script: returning internals keeps this on the real
  // function rather than on a copy of it.
  const internals = new Function('chrome', 'WebSocket', 'console', `${source}\n;return { attach, detach, attached };`)
  const WebSocketStub = class { constructor() {} addEventListener() {} send() {} close() {} }
  return internals(chrome, WebSocketStub, console)
}

test('attach:同一标签页的并发调用只向 Chrome 发一次,且双双成功', async () => {
  let nativeCalls = 0
  let enables = 0
  const worker = loadWorker({
    debugger: {
      async attach() {
        nativeCalls += 1
        // Chrome rejects a second attach from the same extension.
        if (nativeCalls > 1) throw new Error('Another debugger is already attached to the tab with id: 500')
      },
      async detach() {},
      async sendCommand() { enables += 1 },
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  })

  const results = await Promise.allSettled([worker.attach(500), worker.attach(500), worker.attach(500)])
  const rejected = results.filter((entry) => entry.status === 'rejected')
  assert.equal(rejected.length, 0,
    `并发 attach 不应有失败者:${rejected.map((entry) => entry.reason?.message).join('; ')}`)
  assert.equal(nativeCalls, 1, 'chrome.debugger.attach 只该被调用一次')
  assert.equal(enables, 4, '每个并发调用方都该看到已启用的四个域,但不该重复启用')
  assert.ok(worker.attached.has(500), 'attach 成功后标签页应记在 attached 里')
})

test('attach:一次失败不会永久毒化该标签页的重试', async () => {
  let nativeCalls = 0
  const worker = loadWorker({
    debugger: {
      async attach() {
        nativeCalls += 1
        if (nativeCalls === 1) throw new Error('Cannot attach to this target')
      },
      async detach() {},
      async sendCommand() {},
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  })

  await assert.rejects(() => worker.attach(501), /Cannot attach to this target/)
  await worker.attach(501)
  assert.equal(nativeCalls, 2, '失败后必须允许重试')
  assert.ok(worker.attached.has(501))
})

test('attach:已挂上的标签页直接返回,不再打扰 Chrome', async () => {
  let nativeCalls = 0
  const worker = loadWorker({
    debugger: {
      async attach() { nativeCalls += 1 },
      async detach() {}, async sendCommand() {},
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  })
  await worker.attach(502)
  await worker.attach(502)
  assert.equal(nativeCalls, 1)
})
