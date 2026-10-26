/**
 * 切会话的历史加载态:session.open 返回时历史往往还没到(要等 follow 流的 snapshot 帧),
 * 这段时间 nodes 为空。视图必须靠 store 的 historyLoaded 区分"还在加载"和"真的是空会话",
 * 否则会先闪一片空白/「开始对话」空态,用户看不出正在加载。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="session-loading" hidden></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const { createSessionService } = await import('../src/features/sessions/session-service.js')
const { isAwaitingHistory, mountSessionLoading } = await import('../src/features/chat/session-loading.js')

const follow = (sessionId, value) => ({ type: 'item', streamId: `follow:${sessionId}`, value })
const turn = (seq) => ({ event: { seq, type: 'turn/start', time: 1000, data: { turn: 1 } } })

function harness() {
  const connection = {
    subscribe() {},
    unsubscribe() {},
    async call() { return {} }
  }
  return createSessionService(connection)
}

test('open 返回后、follow snapshot 到达前:历史未落地,处于加载态', async () => {
  const service = harness()
  await service.open('s1')
  const snapshot = service.getRuntimeSnapshot()
  assert.equal(snapshot.sessionId, 's1')
  assert.equal(snapshot.historyLoaded, false)
  assert.equal(snapshot.nodes.length, 0)
  assert.equal(isAwaitingHistory(snapshot), true)
})

test('follow snapshot 到达后:历史落地,加载态结束', async () => {
  const service = harness()
  await service.open('s1')
  service.handleMuxFrame(follow('s1', { type: 'snapshot', cursor: 1, records: [turn(1)] }))
  const snapshot = service.getRuntimeSnapshot()
  assert.equal(snapshot.historyLoaded, true)
  assert.equal(isAwaitingHistory(snapshot), false)
})

test('空会话的 snapshot(0 条记录)同样算已落地 —— 该给空态,不能一直转圈', async () => {
  const service = harness()
  await service.open('s1')
  service.handleMuxFrame(follow('s1', { type: 'snapshot', cursor: -1, records: [] }))
  const snapshot = service.getRuntimeSnapshot()
  assert.equal(snapshot.nodes.length, 0)
  assert.equal(isAwaitingHistory(snapshot), false)
})

test('follow 流报错是终态:不再显示加载态', async () => {
  const service = harness()
  await service.open('s1')
  service.handleMuxFrame({ type: 'error', streamId: 'follow:s1', error: { message: 'resume failed' } })
  const snapshot = service.getRuntimeSnapshot()
  assert.equal(snapshot.historyError, 'resume failed')
  assert.equal(isAwaitingHistory(snapshot), false)
})

test('切到另一个会话:上一个会话的"已落地"不能带过去', async () => {
  const service = harness()
  await service.open('s1')
  service.handleMuxFrame(follow('s1', { type: 'snapshot', cursor: 1, records: [turn(1)] }))
  await service.open('s2')
  const snapshot = service.getRuntimeSnapshot()
  assert.equal(snapshot.sessionId, 's2')
  assert.equal(isAwaitingHistory(snapshot), true)
  // 迟到的 s1 帧不会把 s2 标成已落地。
  service.handleMuxFrame(follow('s1', { type: 'snapshot', cursor: 2, records: [turn(1), turn(2)] }))
  assert.equal(isAwaitingHistory(service.getRuntimeSnapshot()), true)
})

test('刚新建的会话没有历史可等;已有乐观内容时也不挡', () => {
  const base = { sessionId: 's1', historyLoaded: false, historyError: null, nodes: [], pendingSteering: [] }
  assert.equal(isAwaitingHistory(base), true)
  assert.equal(isAwaitingHistory(base, { freshSessionId: 's1' }), false)
  assert.equal(isAwaitingHistory(base, { freshSessionId: 'other' }), true)
  assert.equal(isAwaitingHistory({ ...base, pendingSteering: [{}] }), false)
  assert.equal(isAwaitingHistory(null), false)
})

test('加载层:显示转圈、文案与骨架,收起即隐藏', () => {
  const host = document.getElementById('session-loading')
  const loading = mountSessionLoading(host)
  assert.equal(host.getAttribute('role'), 'status')
  assert.equal(loading.visible, false)
  loading.show()
  assert.equal(host.hidden, false)
  assert.ok(host.querySelector('.session-loading-spinner'))
  assert.ok(host.querySelector('.session-loading-label').textContent.length > 0)
  assert.ok(host.querySelectorAll('.session-loading-skeleton .sk-user').length >= 1)
  assert.ok(host.querySelectorAll('.session-loading-skeleton .sk-line').length >= 3)
  loading.set(false)
  assert.equal(host.hidden, true)
})
