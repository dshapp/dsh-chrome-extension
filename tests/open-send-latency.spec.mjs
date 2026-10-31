/**
 * 打开会话 / 发送消息的体感延迟回归。
 *
 * 1. 打开已有会话不再先 session/create 认领:宿主对具名会话 claim → 同步 resume agent
 *    (实测 200~280ms),而且排在 follow 前串行等待。对齐 DSH Web,只开 follow{activate:true}。
 * 2. mux 载体 iframe 不加载 "/"(整个 DSH Web SPA),只加载 /api/remote.mux 这个极轻的文档。
 * 3. 空闲会话发送即回显,durable user/message(source.rpcId === requestId)到达后替换。
 * 4. 大帧不再逐字扫描 UTF-8 字节数。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { exceedsUtf8ByteLimit, MUX_RELAY_DOCUMENT_PATH } from '../src/platform/dsh/downlink.js'

function harness({ promptError } = {}) {
  const calls = []
  const subs = []
  const connection = {
    subscribe(id, endpoint, args) { subs.push({ id, endpoint, args }) },
    unsubscribe() {},
    async call(method, payload) {
      calls.push({ method, payload })
      if (method === 'session/prompt' && promptError) throw promptError
      return { accepted: true }
    }
  }
  return { service: createSessionService(connection), calls, subs }
}

const item = (sessionId, value) => ({ type: 'item', streamId: 'follow:' + sessionId, value })
const userMessage = (seq, rpcId, text) => item('s1', {
  event: { type: 'user/message', seq, time: Date.now(), data: {
    id: 'm-' + seq, role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId }
  } }
})

test('打开已有会话:不调 session/create,立即订阅 follow(activate)', async () => {
  const { service, calls, subs } = harness()
  service.listStore.replaceAll([{ sessionId: 's1', cwd: '/tmp/p', updatedAt: 1 }])
  await service.open('s1')
  assert.equal(calls.filter((c) => c.method === 'session/create').length, 0)
  const follow = subs.find((s) => s.id === 'follow:s1')
  assert.ok(follow, 'follow 流已订阅')
  assert.equal(follow.args.request.activate, true)
  assert.equal(service.currentSessionId, 's1')
})

test('新建会话仍走 session/create', async () => {
  const { service, calls } = harness()
  await service.open(undefined, { cwd: '/tmp/p' })
  assert.equal(calls.filter((c) => c.method === 'session/create').length, 1)
})

test('载体 iframe 文档不是 SPA 根路径', () => {
  assert.equal(MUX_RELAY_DOCUMENT_PATH, '/api/remote.mux')
})

test('空闲会话发送即回显,durable user/message 到达后替换', async () => {
  const { service, calls } = harness()
  await service.open('s1')
  service.handleMuxFrame(item('s1', { type: 'snapshot', cursor: -1, records: [] }))
  const snapshots = []
  service.onRuntimeChange((s) => snapshots.push(s))
  await service.prompt('s1', [{ type: 'text', text: 'hello' }])
  const requestId = calls.find((c) => c.method === 'session/prompt').payload.request.requestId
  const echoed = service.getRuntimeSnapshot().pendingSteering
  assert.equal(echoed.length, 1)
  assert.equal(echoed[0].content[0].text, 'hello')
  assert.ok(snapshots.length >= 1, '回显要立刻推一帧')

  // 宿主注入的其他 user/message(rpcId 不同)不影响回显。
  service.handleMuxFrame(userMessage(0, 'other', 'ctx'))
  assert.equal(service.getRuntimeSnapshot().pendingSteering.length, 1)
  service.handleMuxFrame(userMessage(1, requestId, 'hello'))
  const snap = service.getRuntimeSnapshot()
  assert.equal(snap.pendingSteering.length, 0)
  assert.ok(snap.nodes.some((n) => n.messageId === 'm-1'))
})

test('发送失败撤回回显;运行中排队不回显(交给队列面板)', async () => {
  const failing = harness({ promptError: new Error('boom') })
  await failing.service.open('s1')
  await assert.rejects(failing.service.prompt('s1', [{ type: 'text', text: 'x' }]))
  assert.equal(failing.service.getRuntimeSnapshot().pendingSteering.length, 0)

  const { service } = harness()
  await service.open('s1')
  service.handleMuxFrame(item('s1', { event: { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } } }))
  assert.equal(service.getRuntimeSnapshot().running, true)
  await service.prompt('s1', [{ type: 'text', text: 'later' }])
  assert.equal(service.getRuntimeSnapshot().pendingSteering.length, 0)
})

test('回显之后结束的轮兜底清掉回显;更早的 turn/end 不误清', async () => {
  const { service } = harness()
  await service.open('s1')
  await service.prompt('s1', [{ type: 'text', text: 'hi' }])
  service.handleMuxFrame(item('s1', { event: { type: 'turn/end', seq: 0, time: Date.now() - 60000, data: { turn: 1, reason: { kind: 'completed' } } } }))
  assert.equal(service.getRuntimeSnapshot().pendingSteering.length, 1)
  service.handleMuxFrame(item('s1', { event: { type: 'turn/end', seq: 1, time: Date.now() + 1, data: { turn: 2, reason: { kind: 'cancelled' } } } }))
  assert.equal(service.getRuntimeSnapshot().pendingSteering.length, 0)
})

test('exceedsUtf8ByteLimit:短路判断与逐字计数结果一致', () => {
  assert.equal(exceedsUtf8ByteLimit('a'.repeat(100), 300), false)
  assert.equal(exceedsUtf8ByteLimit('中'.repeat(100), 300), false)
  assert.equal(exceedsUtf8ByteLimit('中'.repeat(101), 300), true)
  assert.equal(exceedsUtf8ByteLimit('a'.repeat(301), 300), true)
  assert.equal(exceedsUtf8ByteLimit('😀'.repeat(75), 300), false)
  assert.equal(exceedsUtf8ByteLimit('😀'.repeat(76), 300), true)
})
