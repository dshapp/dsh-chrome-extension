/**
 * 插队消息在 agent 取走之前就出现在记录尾部。
 *
 * 插队(mode:"steer")的消息先进 next-step inbox,要等 agent 到下一个 step 边界
 * 才写出 durable 的 user/message。当前 step 若是一段长输出/长工具调用,这条消息
 * 会在聊天记录里缺席很久。对齐 web ChatView 的 PendingSteeringBubble:inbox 投影
 * 的 next-step 用户消息作为待插入行贴在尾部,durable 节点到达时被替换。
 *
 * 跑法:node --test tests/pending-steering.spec.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement

const { setLang } = await import('../src/shared/i18n.js')
setLang('en')
const { createSessionStore } = await import('../src/features/sessions/session-store.js')
const { NodeKind, nodeId } = await import('../src/features/sessions/chat-nodes.js')
const { createSteeringNode } = await import('../src/features/chat/node-views.js')

const userMsg = (id, text, kind = 'user') => ({ id, role: 'user', source: { kind, rpcId: 'rpc-' + id }, content: [{ type: 'text', text }] })
const inbox = (nextStep = [], nextTurn = []) => ({ 'next-turn': nextTurn, 'next-step': nextStep })
const splice = (seq, target, { start = 0, removedCount, inserted = [] } = {}) => ({
  seq, time: seq, type: 'agent/inbox/spliced',
  data: { target, start, inserted, ...(removedCount == null ? {} : { removedCount }) }
})

function runningTurn () {
  const store = createSessionStore()
  store.applyEvent({ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent({ seq: 2, time: 2, type: 'step/start', data: { turn: 1, step: 1 } })
  return store
}

test('next-step 里的用户消息在被取走前就作为待插入行出现', () => {
  const store = runningTurn()
  store.applyProjection('inbox', inbox([userMsg('m1', '插一句')]), 3)
  const pending = store.getSnapshot().pendingSteering
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, NodeKind.steering)
  assert.equal(pending[0].pending, true)
  assert.equal(pending[0].messageId, 'm1')
  assert.deepEqual(pending[0].content, [{ type: 'text', text: '插一句' }])
  // 不污染 durable 节点列表(turn process / turn rail / lastNode 都只看它)。
  assert.ok(!store.getSnapshot().nodes.some((node) => node.pending))
})

test('排队(next-turn)与插件注入的 next-step 上下文不算待插入行', () => {
  const store = runningTurn()
  store.applyProjection('inbox', inbox([userMsg('ctx', 'plugin ctx', 'plugin')], [userMsg('q1', 'queued')]), 3)
  assert.deepEqual(store.getSnapshot().pendingSteering, [])
})

test('流式期间的快照复用同一个待插入节点对象(渲染层不重建这一行)', () => {
  const store = runningTurn()
  store.applyProjection('inbox', inbox([userMsg('m1', 'x')]), 3)
  const first = store.getSnapshot().pendingSteering[0]
  store.applyEvent({ seq: 4, time: 4, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
  assert.equal(store.getSnapshot().pendingSteering[0], first)
})

test('agent 取走后由 durable steering 节点接替,且同一 nodeId', () => {
  const store = runningTurn()
  store.applyEvent(splice(3, 'next-step', { inserted: [userMsg('m1', '插一句')] }))
  store.applyProjection('inbox', inbox([userMsg('m1', '插一句')]), 3)
  const pendingId = nodeId(store.getSnapshot().pendingSteering[0])
  // step 边界:认领 + durable user/message;投影还没跟上的一拍里也不能出现两份。
  store.applyEvent(splice(4, 'next-step', { removedCount: 1 }))
  store.applyEvent({ seq: 5, time: 5, type: 'user/message', surfaceOp: { op: 'append' }, data: { message: userMsg('m1', '插一句') } })
  let snap = store.getSnapshot()
  assert.deepEqual(snap.pendingSteering, [])
  const durable = snap.nodes.filter((node) => node.kind === NodeKind.steering)
  assert.equal(durable.length, 1)
  assert.equal(nodeId(durable[0]), pendingId)
  store.applyProjection('inbox', inbox(), 6)
  snap = store.getSnapshot()
  assert.deepEqual(snap.pendingSteering, [])
  assert.equal(snap.nodes.filter((node) => node.kind === NodeKind.steering).length, 1)
})

test('待插入行与正式插队消息同一种气泡,只多一个 pending 标记', () => {
  const store = runningTurn()
  store.applyProjection('inbox', inbox([userMsg('m1', '插一句')]), 3)
  const element = createSteeringNode(store.getSnapshot().pendingSteering[0])
  assert.ok(element.classList.contains('msg-user-turn'))
  assert.equal(element.dataset.pendingSteering, 'true')
  assert.match(element.textContent, /插一句/)
})
