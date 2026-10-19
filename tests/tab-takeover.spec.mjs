/**
 * 标签页「受插件控制 / 正在被操作」favicon 标记。
 *
 * 控制器:工具调用期间(及短暂余韵内)呼吸(active),之后留下静止圈(idle),
 * 直到标签页关闭或被交还才 stop;后发的命令不能被先发的异步注入反超。
 * 页面脚本:idle/active 两种帧,暂时停用页面自己的 icon link,stop 时原样还原。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

import { createTabTakeover, isTakeoverFrame } from '../src/features/tab-takeover/takeover-controller.js'
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
  const saved = []
  const takeover = createTabTakeover({
    inject: async (tabId, command) => { log.push(`${command}:${tabId}`) },
    captureFavicon: async () => 'data:image/png;base64,AAAA',
    persist: (ids) => saved.push([...ids].sort()),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    lingerMs: 1000, tickMs: 100, refreshMs: 5000, pageTtlMs: 15000,
  })
  return { clock, log, saved, takeover }
}

test('操作中呼吸,余韵过后停下留下静止圈,而不是拆掉', async () => {
  const { clock, log, saved, takeover } = setup()
  const release = takeover.begin(() => 7)
  await flush()
  assert.equal(takeover.modeOf(7), 'active')
  assert.deepEqual(log, ['active:7'])
  assert.deepEqual(saved.at(-1), [7], '操作过即记为受控并持久化')
  release()
  await clock.advance(500)
  assert.equal(takeover.modeOf(7), 'active', '余韵内仍在转')
  await clock.advance(600)
  assert.equal(takeover.modeOf(7), 'idle')
  assert.deepEqual(log, ['active:7', 'idle:7'])
  await clock.advance(60_000)
  assert.equal(takeover.modeOf(7), 'idle', '静止圈一直保留')
  assert.deepEqual(log, ['active:7', 'idle:7'])
})

test('受控标签页再次被操作:静止 → 呼吸 → 静止;连续调用之间不断档', async () => {
  const { clock, log, takeover } = setup()
  takeover.begin(() => 3)()
  await clock.advance(300)
  const release = takeover.begin(() => 3)
  await clock.advance(2000)
  release()
  await clock.advance(1100)
  assert.deepEqual(log, ['active:3', 'idle:3'])
  takeover.touch(3)
  await flush()
  await clock.advance(1100)
  assert.deepEqual(log, ['active:3', 'idle:3', 'active:3', 'idle:3'])
})

test('会话选中的标签页(find_tab)即受控:静止圈,不转', async () => {
  const { log, takeover } = setup()
  takeover.mark(11)
  await flush()
  assert.equal(takeover.modeOf(11), 'idle')
  assert.deepEqual(log, ['idle:11'])
  takeover.mark(11)
  await flush()
  assert.deepEqual(log, ['idle:11'], '重复标记无副作用')
})

test('交还(release)或关闭标签页才拆掉标记', async () => {
  const { clock, log, saved, takeover } = setup()
  takeover.begin(() => 4)()
  takeover.mark(5)
  await clock.advance(1100)
  takeover.release(4)
  await flush()
  assert.equal(takeover.modeOf(4), null)
  assert.ok(log.includes('stop:4'))
  takeover.tabRemoved(5)
  assert.deepEqual(takeover.controlledTabs(), [])
  assert.deepEqual(saved.at(-1), [])
})

test('交还时即使还在余韵里,也直接拆掉而不是回到静止圈', async () => {
  const { log, takeover } = setup()
  takeover.begin(() => 6)()
  await flush()
  takeover.release(6)
  await flush()
  assert.equal(takeover.modeOf(6), null)
  assert.equal(log.at(-1), 'stop:6')
})

test('SW 重启后从持久化恢复静止圈', async () => {
  const { log, takeover } = setup()
  takeover.restore([21, 22])
  await flush()
  assert.deepEqual(log.sort(), ['idle:21', 'idle:22'])
})

test('调用中途会话换到新标签页(navigate newTab)也会呼吸', async () => {
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
  assert.equal(takeover.modeOf(42), 'idle')
})

test('呼吸期间定期续命页面截止时间,静止时不续', async () => {
  const { clock, log, takeover } = setup()
  const release = takeover.begin(() => 9)
  await clock.advance(11000)
  assert.deepEqual(log, ['active:9', 'active:9', 'active:9'])
  release()
  await clock.advance(30000)
  assert.deepEqual(log, ['active:9', 'active:9', 'active:9', 'idle:9'])
})

test('后发的命令不会被更早发出、尚未完成的注入反超', async () => {
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
  assert.equal(typeof releaseCapture, 'function', '首个注入正在取 favicon')
  release()
  takeover.release(1)
  await flush()
  releaseCapture()
  await flush()
  await flush()
  // 记录在 favicon 取回前就被撤销,先前的注入自觉放弃;只剩 stop。
  assert.deepEqual(log, ['stop'])
})

test('换页后重新注入(静止圈也跟着新页面走);动效帧(data:)触发的变化被忽略', async () => {
  const { clock, log, takeover } = setup()
  takeover.mark(5)
  await flush()
  takeover.tabUpdated(5, { favIconUrl: 'data:image/png;base64,QQ==' })
  await flush()
  assert.deepEqual(log, ['idle:5'])
  takeover.tabUpdated(5, { status: 'complete' })
  await flush()
  assert.deepEqual(log, ['idle:5', 'idle:5'])
  log.length = 0
  takeover.tabUpdated(5, { status: 'loading' })
  await clock.advance(2000)
  assert.equal(log.filter((e) => e === 'idle:5').length, 4)
  log.length = 0
  takeover.tabUpdated(5, { favIconUrl: 'https://a.test/favicon.ico' })
  await flush()
  assert.deepEqual(log, ['idle:5'])
  log.length = 0
  takeover.tabUpdated(99, { status: 'complete' })
  await flush()
  assert.deepEqual(log, [], '未受控的标签页不注入')
})

test('换页后先取一次,加载完成时再取一次页面声明的图标;同一页面不重复取', async () => {
  const clock = fakeClock()
  let captures = 0
  const takeover = createTabTakeover({
    inject: async () => {},
    captureFavicon: async () => { captures += 1; return 'data:image/x-icon;base64,AA' },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, reinjectDelays: [],
  })
  takeover.mark(3)
  await flush()
  assert.equal(captures, 1)
  takeover.tabUpdated(3, { url: 'https://b.test/', status: 'loading' })
  await flush()
  assert.equal(captures, 2, '换页:重新取')
  takeover.tabUpdated(3, { status: 'complete' })
  await flush()
  assert.equal(captures, 3, '加载完再取一次')
  takeover.tabUpdated(3, { status: 'complete' })
  await flush()
  assert.equal(captures, 3, '同一页面不重复取')
})

test('取图标期间换了页:旧页面取到的结果作废,不会盖掉换页后的重新取', async () => {
  const clock = fakeClock()
  const pending = []
  const injected = []
  const takeover = createTabTakeover({
    inject: async (tabId, command, opts) => { injected.push(opts?.favicon ?? null) },
    captureFavicon: () => new Promise((r) => pending.push(r)),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, reinjectDelays: [],
  })
  takeover.mark(2)
  await flush()
  assert.equal(pending.length, 1, '正在取旧页面的图标')
  takeover.tabUpdated(2, { url: 'https://new.test/', status: 'loading' })
  pending[0]('data:old-page-frame')
  await flush(); await flush()
  assert.equal(pending.length, 2, '换页后重新取')
  pending[1]('data:new-page-icon')
  await flush(); await flush()
  assert.deepEqual(injected, [null, 'data:new-page-icon'], '旧结果被丢弃,最终用新页面的图标')
})

test('会话两次调用之间(agent 在思考)当前标签页保持呼吸;转去别的标签页或会话结束即停', async () => {
  const clock = fakeClock()
  const takeover = createTabTakeover({
    inject: async () => {},
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    lingerMs: 1000, sessionLingerMs: 10000, tickMs: 100,
  })
  let current = 1
  takeover.begin(() => current, 's')()
  await clock.advance(5000)
  assert.equal(takeover.modeOf(1), 'active', '思考期间仍在呼吸')
  current = 2
  takeover.begin(() => current, 's')()
  await clock.advance(1200)
  assert.equal(takeover.modeOf(1), 'idle', '会话转去别的标签页:旧的回到静止圈')
  assert.equal(takeover.modeOf(2), 'active')
  await clock.advance(9000)
  assert.equal(takeover.modeOf(2), 'idle', '会话很久没动静:停下')
  takeover.begin(() => current, 's')()
  await clock.advance(100)
  takeover.endSession('s')
  await clock.advance(1100)
  assert.equal(takeover.modeOf(2), 'idle', '会话结束立即停下(只剩短余韵)')
})

test('isTakeoverFrame 凭内容认帧:带戳的 PNG / SVG 是,站点图标不是', () => {
  // 1×1 PNG,手工插入与页面脚本相同的 tEXt 块。
  const plain = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex')
  const text = Buffer.from('tEXtSoftware\0dsh-takeover', 'latin1')
  const len = Buffer.alloc(4); len.writeUInt32BE(text.length - 4)
  const tagged = Buffer.concat([plain.subarray(0, plain.length - 12), len, text, Buffer.alloc(4), plain.subarray(plain.length - 12)])
  assert.equal(isTakeoverFrame('data:image/png;base64,' + plain.toString('base64')), false)
  assert.equal(isTakeoverFrame('data:image/png;base64,' + tagged.toString('base64')), true)
  assert.equal(isTakeoverFrame('data:image/svg+xml,' + encodeURIComponent('<svg data-dsh-takeover="1"/>')), true)
  assert.equal(isTakeoverFrame('data:image/svg+xml,' + encodeURIComponent('<svg/>')), false)
  assert.equal(isTakeoverFrame('https://a.test/favicon.ico'), false)
  assert.equal(isTakeoverFrame(undefined), false)
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

test('background.js 经由钩子上报:操作类 begin/release,选中后 mark,close_session 留下的标签页 release', async () => {
  const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')
  const handler = { addListener() {}, removeListener() {} }
  const chrome = {
    runtime: { id: 't', getManifest: () => ({ version: '0' }), onMessage: handler, onStartup: handler, onInstalled: handler },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({ dsh_borrowed_tabs: { s: [77] } }), set: async () => {} }, onChanged: handler },
    alarms: { create() {}, onAlarm: handler },
    tabs: { get: async () => ({ status: 'complete', groupId: -1 }), query: async () => [], remove: async () => {}, onUpdated: handler, onRemoved: handler },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: 1 } }), onDetach: handler, onEvent: handler },
  }
  const events = []
  globalThis.__dshTabTakeover = {
    begin: (getter) => { events.push(['begin', getter()]); return () => events.push(['end', getter()]) },
    touch: (id) => events.push(['touch', id]),
    mark: (id) => events.push(['mark', id]),
    release: (id) => events.push(['release', id]),
  }
  try {
    const internals = new Function('chrome', 'WebSocket', 'console',
      `${source}\n;return { runToolCall, sessionTabs };`)
    const WebSocketStub = class { addEventListener() {} send() {} close() {} }
    const { runToolCall, sessionTabs } = internals(chrome, WebSocketStub, console)
    sessionTabs.set('s', 77)
    await runToolCall({ requestId: 'r1', payload: { name: 'wait', args: { session: 's', ms: 1 } } })
    await runToolCall({ requestId: 'r2', payload: { name: 'list_tabs', args: { session: 's' } } })
    await runToolCall({ requestId: 'r3', payload: { name: 'close_session', args: { session: 's' } } })
    assert.deepEqual(events.filter((e) => e[0] !== 'touch'), [
      ['begin', 77], ['end', 77], ['mark', 77],
      ['mark', 77],
      ['release', 77],
    ])
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

test('页面脚本:idle 静止帧 / active 呼吸帧,停用页面 icon,stop 后原样还原', async () => {
  const { window, run } = pageWindow(
    '<head><link rel="shortcut icon" href="/a.ico"><link rel="apple-touch-icon" href="/t.png"></head><body></body>')
  const doc = window.document
  try {
    assert.deepEqual(run('idle', { ttlMs: 60000 }), { started: true, mode: 'idle' })
    const ours = doc.querySelector('link[data-dsh-takeover]')
    assert.ok(ours, '插入了标记 link')
    assert.equal(ours.getAttribute('rel'), 'icon')
    const idleHref = ours.getAttribute('href')
    // 不能带 MIME 参数:Chrome 会丢弃 data:image/png;x=1;base64 这种 favicon。
    assert.match(idleHref, /^data:image\/(png|svg\+xml)[,;]/)
    assert.doesNotMatch(idleHref, /^data:[^,]*;[a-z-]+=/)
    const state = globalThis.__dshTabTakeover
    assert.equal(state.mode, 'idle')
    assert.ok(isTakeoverFrame(idleHref), '帧带 dsh-takeover 戳,任何地方都能认出来')
    assert.ok(state.isOwnFrame(idleHref), '能认出自己的帧')
    assert.equal(state.isOwnFrame('https://site.test/a.ico'), false)
    assert.equal(state.timer, 0, '静止时不跑节拍器')
    assert.equal(state.worker, null)
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(ours.getAttribute('href'), idleHref, '静止圈不动')

    const page = doc.querySelector('link[href="/a.ico"]')
    assert.equal(page.getAttribute('rel'), 'dsh-takeover-suspended')
    assert.equal(doc.querySelector('link[href="/t.png"]').getAttribute('rel'), 'apple-touch-icon', '非 icon 的 rel 不动')

    // 切到呼吸:换成呼吸帧,开始换帧。
    assert.deepEqual(run('active', { ttlMs: 60000 }), { refreshed: true, mode: 'active' })
    assert.equal(state.mode, 'active')
    const activeHref = ours.getAttribute('href')
    assert.notEqual(activeHref, idleHref)
    assert.ok(state.isOwnFrame(activeHref))
    assert.ok(state.timer || state.worker, '呼吸时节拍器在跑')

    // 呼吸截止时间到了(SW 没来得及切回)→ 自己退回静止圈,而不是拆掉。
    state.apply('active', 1, null)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(state.mode, 'idle')
    assert.equal(ours.getAttribute('href'), idleHref)
    assert.equal(state.timer, 0)

    // 页面中途新加的 icon 也被停用。
    const late = doc.createElement('link')
    late.rel = 'icon'
    late.href = '/late.png'
    doc.head.appendChild(late)
    await flush()
    assert.equal(late.getAttribute('rel'), 'dsh-takeover-suspended')

    // 扩展重载后的新注入(另一个隔离世界,状态互不可见)会拆掉旧世界留下的标记 link。
    const stateBefore = globalThis.__dshTabTakeover
    delete globalThis.__dshTabTakeover
    run('idle', { ttlMs: 60000 })
    assert.equal(doc.querySelectorAll('link[data-dsh-takeover]').length, 1, '只剩新的一个标记')
    assert.notEqual(doc.querySelector('link[data-dsh-takeover]'), ours)
    stateBefore.stop()

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
