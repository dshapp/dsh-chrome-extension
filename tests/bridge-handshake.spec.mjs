/**
 * 桥的"已连接"必须由 daemon 的 hello_ack 证实,而不只是 WebSocket open。
 *
 * 实际事故:一个父进程已退出的 0.3.12 chrome-daemon 因 stdio 断管,读任务在
 * 扩展连接 attach 之后就 panic 了 —— TCP/WS 照样建立,扩展收到 open 就报
 * "已连接",但 daemon 从此收不到 hello / pong / tool_result,所有
 * mcp__chrome__* 调用超时,设置页却一直亮着绿灯。
 *
 * 这里锁住:
 *   - open 之后只是 handshaking,收到 hello_ack 才 connected;
 *   - hello_ack 超时 → status "unresponsive",socket 被放弃,下一次 reconcile
 *     立即重连(不等一个可能永远不来的 close 事件);
 *   - 已连接后长时间收不到任何帧(daemon 每 30s ping 一次)→ 同样判为无响应;
 *   - 握手完成前工具结果只排队、握手后再重放;
 *   - 端口上没人监听 → 仍是 "connecting",不误报为无响应。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')

const flush = () => new Promise((resolve) => setImmediate(resolve))

function loadWorker() {
  const handler = { addListener() {}, removeListener() {} }
  const chrome = {
    runtime: { id: 'test', getManifest: () => ({ version: '9.9.9' }), getPlatformInfo: async () => ({ os: 'mac' }),
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
    debugger: {
      attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}),
      onDetach: handler, onEvent: handler,
    },
  }

  // 手动时钟:定时器只在 advance() 时触发,Date.now() 跟着走。
  let now = 1_000_000
  let nextId = 1
  const timers = new Map()
  const fakeSetTimeout = (fn, ms = 0) => {
    const id = nextId++
    timers.set(id, { fn, at: now + ms })
    return id
  }
  const fakeClearTimeout = (id) => { timers.delete(id) }
  const advance = (ms) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.has(id)) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
  class FakeDate extends Date {
    static now() { return now }
  }

  const sockets = []
  class FakeWebSocket {
    static OPEN = 1
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.closed = false
      this.listeners = {}
      sockets.push(this)
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.closed = true; this.readyState = 3 }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event) }
    open() { this.readyState = 1; this.emit('open') }
    receive(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
  }

  // Source is a classic script: returning internals keeps this on the real
  // functions rather than on copies of them.
  const internals = new Function(
    'chrome', 'WebSocket', 'console', 'setTimeout', 'clearTimeout', 'Date',
    source + '\n;return { reconcile, send, bridgeStatus, isConnected, pending, state: () => globalThis.__dshBridgeState() };',
  )
  const worker = internals(chrome, FakeWebSocket, console, fakeSetTimeout, fakeClearTimeout, FakeDate)
  return { worker, sockets, advance }
}

test('open 只算握手中;收到 hello_ack 才算已连接', async () => {
  const { worker, sockets } = loadWorker()
  await flush()
  assert.equal(sockets.length, 1, '冷启动应发起一次连接')
  const ws = sockets[0]
  ws.open()
  assert.deepEqual(ws.sent[0], { type: 'hello', payload: { extensionVersion: '9.9.9' } })
  assert.equal(worker.isConnected(), false, 'open 之后还没有证实 daemon 在读')
  assert.equal(worker.bridgeStatus(), 'connecting')

  ws.receive({ type: 'hello_ack' })
  assert.equal(worker.isConnected(), true)
  assert.equal(worker.bridgeStatus(), 'connected')
  assert.equal((await worker.state()).status, 'connected')
})

test('hello_ack 超时 → 无响应,并立即可以重连', async () => {
  const { worker, sockets, advance } = loadWorker()
  await flush()
  const stuck = sockets[0]
  stuck.open()
  // 卡死的 daemon:writer 还活着(甚至会派发 tool_call),但从不回 hello_ack。
  advance(10_001)
  assert.equal(stuck.closed, true, '超时后应放弃这条 socket')
  assert.equal(worker.isConnected(), false)
  assert.equal(worker.bridgeStatus(), 'unresponsive')

  // 不等 close 事件:下一次 reconcile 直接开新连接。
  await worker.reconcile()
  assert.equal(sockets.length, 2)
  // 重试期间仍显示无响应,直到握手真的成功。
  sockets[1].open()
  assert.equal(worker.bridgeStatus(), 'unresponsive')
  sockets[1].receive({ type: 'hello_ack' })
  assert.equal(worker.bridgeStatus(), 'connected')

  // 被放弃的旧 socket 迟到的事件不得改动当前状态。
  stuck.emit('close')
  stuck.receive({ type: 'hello_ack' })
  assert.equal(worker.bridgeStatus(), 'connected')
  assert.equal(sockets.length, 2)
})

test('已连接后长时间收不到任何帧 → 判为无响应并重连', async () => {
  const { worker, sockets, advance } = loadWorker()
  await flush()
  const ws = sockets[0]
  ws.open()
  ws.receive({ type: 'hello_ack' })

  // daemon 的 ping 会刷新活性并收到 pong。
  advance(30_000)
  ws.receive({ type: 'ping' })
  assert.deepEqual(ws.sent.at(-1), { type: 'pong' })
  advance(60_000)
  await worker.reconcile()
  assert.equal(worker.bridgeStatus(), 'connected', '75s 窗口内有过 ping,不应判死')
  assert.equal(sockets.length, 1)

  advance(20_000)
  await worker.reconcile()
  assert.equal(ws.closed, true, '超过活性窗口没有任何帧,应放弃')
  assert.equal(worker.bridgeStatus(), 'unresponsive')
  assert.equal(sockets.length, 2, '同一次 reconcile 里就该重连')
})

test('握手完成前工具结果只排队,握手后按序重放', async () => {
  const { worker, sockets } = loadWorker()
  await flush()
  const ws = sockets[0]
  ws.open()
  worker.send({ type: 'tool_result', responseToRequestId: 'a', payload: { data: 1 } }, { replayable: true })
  assert.equal(ws.sent.some((frame) => frame.type === 'tool_result'), false,
    '对端是否在读尚未证实,工具结果不该直接发出')
  ws.receive({ type: 'hello_ack' })
  assert.deepEqual(
    ws.sent.filter((frame) => frame.type === 'tool_result').map((frame) => frame.responseToRequestId),
    ['a'],
  )
  assert.equal(worker.pending.length, 0)
})

test('端口上没人监听 → 仍是连接中,不误报无响应', async () => {
  const { worker, sockets, advance } = loadWorker()
  await flush()
  sockets[0].emit('error')
  assert.equal(worker.bridgeStatus(), 'connecting')

  // open 都没等到的超时同样只是"连不上",不是"无响应"。
  await worker.reconcile()
  advance(10_001)
  assert.equal(sockets[1].closed, true)
  assert.equal(worker.bridgeStatus(), 'connecting')
})

test('无响应之后 daemon 消失(连接被拒)→ 回到连接中', async () => {
  const { worker, sockets, advance } = loadWorker()
  await flush()
  sockets[0].open()
  advance(10_001)
  assert.equal(worker.bridgeStatus(), 'unresponsive')
  await worker.reconcile()
  sockets[1].emit('error')
  assert.equal(worker.bridgeStatus(), 'connecting')
})
