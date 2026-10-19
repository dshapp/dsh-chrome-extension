/**
 * 标签页「正在被接管」favicon 动效。
 *
 * 控制器:工具调用期间(及短暂余韵内)标签页处于激活态,结束后发 stop;
 * stop 必须排在更早的 start 之后,不能被异步注入反超。
 * 页面脚本:暂时停用页面自己的 icon link,stop 时原样还原。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

import { createTabTakeover } from '../src/features/tab-takeover/takeover-controller.js'
import { tabTakeoverPageScript } from '../src/features/tab-takeover/takeover-page-script.js'

function fakeClock() {
  let time = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: time + ms, fn }); return id },
    clearTimer(id) { timers.delete(id) },
    async advance(ms) {
      const end = time + ms
      for (;;) {
        let next = null
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        timers.delete(next[0])
        time = next[1].at
        next[1].fn()
        await flush()
      }
      time = end
      await flush()
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

function setup() {
  const clock = fakeClock()
  const log = []
  const takeover = createTabTakeover({
    inject: async (tabId, command) => { log.push(`${command}:${tabId}`) },
    captureFavicon: async () => 'data:image/png;base64,AAAA',
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    lingerMs: 1000, tickMs: 100, refreshMs: 5000, pageTtlMs: 15000,
  })
  return { clock, log, takeover }
}

test('工具调用期间激活,结束后余韵过去才 stop', async () => {
  const { clock, log, takeover } = setup()
  const release = takeover.begin(() => 7)
  await flush()
  assert.ok(takeover.isActive(7))
  assert.deepEqual(log, ['start:7'])
  release()
  await clock.advance(500)
  assert.ok(takeover.isActive(7), '余韵内仍保持')
  await clock.advance(600)
  assert.equal(takeover.isActive(7), false)
  assert.deepEqual(log, ['start:7', 'stop:7'])
})

test('连续调用之间不闪:余韵内的下一次调用接着用,不重新 start', async () => {
  const { clock, log, takeover } = setup()
  takeover.begin(() => 3)()
  await clock.advance(300)
  const release = takeover.begin(() => 3)
  await clock.advance(2000)
  release()
  await clock.advance(1100)
  assert.deepEqual(log, ['start:3', 'stop:3'])
})

test('调用中途会话换到新标签页(navigate newTab)也会被点亮', async () => {
  const { clock, takeover } = setup()
  let tab
  const release = takeover.begin(() => tab)
  await flush()
  assert.deepEqual(takeover.activeTabs(), [])
  tab = 42
  await clock.advance(150)
  assert.deepEqual(takeover.activeTabs(), [42])
  release()
  await clock.advance(1100)
  assert.deepEqual(takeover.activeTabs(), [])
})

test('CDP 触碰点亮标签页,长时间调用会定期续命页面看门狗', async () => {
  const { clock, log, takeover } = setup()
  const release = takeover.begin(() => 9)
  await clock.advance(11000)
  assert.deepEqual(log, ['start:9', 'start:9', 'start:9'])
  release()
  takeover.touch(10)
  await flush()
  assert.ok(takeover.isActive(10))
})

test('stop 不会被更早发出、尚未完成的 start 反超', async () => {
  const clock = fakeClock()
  const log = []
  let releaseCapture
  const takeover = createTabTakeover({
    inject: async (tabId, command) => { log.push(command) },
    captureFavicon: () => new Promise((r) => { releaseCapture = () => r(null) }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, lingerMs: 0,
  })
  const release = takeover.begin(() => 1)
  await flush()
  assert.equal(typeof releaseCapture, 'function', 'start 已在取 favicon')
  release()
  await flush()
  releaseCapture()
  await flush()
  await flush()
  // 激活记录在 favicon 取回前就被撤销,start 自觉放弃;只剩 stop。
  assert.deepEqual(log, ['stop'])
})

test('换页后重新注入;动效帧(data:)触发的 favIconUrl 变化被忽略', async () => {
  const { clock, log, takeover } = setup()
  takeover.begin(() => 5)
  await flush()
  takeover.tabUpdated(5, { favIconUrl: 'data:image/png;base64,QQ==' })
  await flush()
  assert.deepEqual(log, ['start:5'])
  takeover.tabUpdated(5, { status: 'complete' })
  await flush()
  assert.deepEqual(log, ['start:5', 'start:5'])
  log.length = 0
  // loading 后补注入几次,覆盖"loading 早于新文档提交"的情况。
  takeover.tabUpdated(5, { status: 'loading' })
  await clock.advance(2000)
  assert.equal(log.filter((e) => e === 'start:5').length, 4)
  log.length = 0
  // 新页面的真实图标到了:重新取图标再注入。
  takeover.tabUpdated(5, { favIconUrl: 'https://a.test/favicon.ico' })
  await flush()
  assert.deepEqual(log, ['start:5'])
})

test('拿不到 Worker 的页面请求脉冲:激活期间定时 tick,结束即停', async () => {
  const clock = fakeClock()
  const ticks = []
  const takeover = createTabTakeover({
    inject: async () => {}, pulse: (id) => ticks.push(id),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    lingerMs: 0, tickMs: 100, pulseMs: 100,
  })
  takeover.requestPulse(8)
  await clock.advance(500)
  assert.equal(ticks.length, 0, '未激活的标签页不发')
  const release = takeover.begin(() => 8)
  takeover.requestPulse(8)
  takeover.requestPulse(8)
  await clock.advance(1000)
  assert.equal(ticks.length, 10, '重复请求不叠加')
  release()
  await clock.advance(1000)
  assert.equal(ticks.length, 10)
})

test('background.js 的工具调用经由钩子 begin/release,管理类工具不点亮', async () => {
  const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')
  const handler = { addListener() {}, removeListener() {} }
  const chrome = {
    runtime: { id: 't', getManifest: () => ({ version: '0' }), onMessage: handler, onStartup: handler, onInstalled: handler },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} }, onChanged: handler },
    alarms: { create() {}, onAlarm: handler },
    tabs: { get: async () => ({ status: 'complete' }), query: async () => [], onUpdated: handler, onRemoved: handler },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: 1 } }), onDetach: handler, onEvent: handler },
  }
  const events = []
  globalThis.__dshTabTakeover = {
    begin: (getter) => { events.push(['begin', getter()]); return () => events.push(['release', getter()]) },
    touch: (id) => events.push(['touch', id]),
  }
  try {
    const internals = new Function('chrome', 'WebSocket', 'console',
      `${source}\n;return { runToolCall, sessionTabs };`)
    const WebSocketStub = class { addEventListener() {} send() {} close() {} }
    const { runToolCall, sessionTabs } = internals(chrome, WebSocketStub, console)
    sessionTabs.set('s', 77)
    await runToolCall({ requestId: 'r1', payload: { name: 'wait', args: { session: 's', ms: 1 } } })
    await runToolCall({ requestId: 'r2', payload: { name: 'list_tabs', args: { session: 's' } } })
    assert.deepEqual(events.filter((e) => e[0] !== 'touch'), [['begin', 77], ['release', 77]])
  } finally {
    delete globalThis.__dshTabTakeover
  }
})

function pageWindow(html) {
  const dom = new JSDOM(html, { url: 'https://site.test/' })
  const { window } = dom
  const run = (command, options) => {
    const prev = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, Image: globalThis.Image }
    Object.assign(globalThis, { document: window.document, MutationObserver: window.MutationObserver, Image: window.Image })
    try { return tabTakeoverPageScript.call(window, command, options) } finally { Object.assign(globalThis, prev) }
  }
  return { window, run }
}

test('页面脚本:停用页面 icon、插入动效 link,stop 后原样还原', async () => {
  const { window, run } = pageWindow(
    '<head><link rel="shortcut icon" href="/a.ico"><link rel="apple-touch-icon" href="/t.png"></head><body></body>')
  const doc = window.document
  try {
    assert.deepEqual(run('start', { ttlMs: 60000 }), { started: true })
    const ours = doc.querySelector('link[data-dsh-takeover]')
    assert.ok(ours, '插入了动效 link')
    assert.equal(ours.getAttribute('rel'), 'icon')
    const href = ours.getAttribute('href')
    // 不能带 MIME 参数:Chrome 会丢弃 data:image/png;x=1;base64 这种 favicon。
    assert.match(href, /^data:image\/(png|svg\+xml)[,;]/)
    assert.doesNotMatch(href, /^data:[^,]*;[a-z-]+=/)
    // 页面脚本把状态挂在它所在世界的 globalThis 上(此处即 Node 的)。
    assert.ok(globalThis.__dshTabTakeover.isOwnFrame(href), '能认出自己的帧')
    assert.equal(globalThis.__dshTabTakeover.isOwnFrame('https://site.test/a.ico'), false)
    const page = doc.querySelector('link[href="/a.ico"]')
    assert.equal(page.getAttribute('rel'), 'dsh-takeover-suspended')
    assert.equal(doc.querySelector('link[href="/t.png"]').getAttribute('rel'), 'apple-touch-icon', '非 icon 的 rel 不动')

    // 页面中途新加的 icon 也被停用。
    const late = doc.createElement('link')
    late.rel = 'icon'
    late.href = '/late.png'
    doc.head.appendChild(late)
    await flush()
    assert.equal(late.getAttribute('rel'), 'dsh-takeover-suspended')

    assert.deepEqual(run('start', { ttlMs: 60000 }), { refreshed: true }, '重复注入是幂等的')

    run('stop')
    assert.equal(doc.querySelector('link[data-dsh-takeover]'), null)
    assert.equal(page.getAttribute('rel'), 'shortcut icon')
    assert.equal(late.getAttribute('rel'), 'icon')
    assert.equal(doc.querySelector('[data-dsh-takeover-rel]'), null)
  } finally {
    run('stop')
    delete globalThis.__dshTabTakeover
    window.close()
  }
})
