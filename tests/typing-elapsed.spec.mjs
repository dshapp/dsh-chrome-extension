/**
 * 运行中底部状态行的用时(对齐 Mac 2710859 runningStartTime):
 * 从本轮 turn/start 起算,思考态也显示,进出思考态不归零;没有 turn/start 时不显示。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const { createChatRenderer, agentStatusLabel, isThinking } = await import('../src/features/chat/chat-renderer.js')
const { createSessionStore } = await import('../src/features/sessions/session-store.js')

test('快照:运行中给出本轮 turn/start 时间,结束后为 null', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent({ type: 'turn/start', seq: 1, time: 5000, data: { turn: 1 } })
  assert.equal(store.getSnapshot().runningStartTime, 5000)
  store.applyEvent({ type: 'turn/end', seq: 2, time: 9000, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(store.getSnapshot().runningStartTime, null)
})

test('指示器:用时取 turn/start 起点,思考态也显示,切换后不归零', () => {
  const host = document.getElementById('host')
  const renderer = createChatRenderer(host)
  const startedAt = Date.now() - 65_000
  renderer.setTyping(true, 'working', startedAt)
  assert.equal(host.querySelector('.typing-time').textContent, ' · 1m 5s')
  renderer.setTyping(false)
  renderer.setThinking(true, startedAt)
  assert.equal(host.querySelector('.typing-indicator.thinking .typing-time').textContent, ' · 1m 5s')
  renderer.setThinking(false)
  renderer.setTyping(true, 'preparing')
  assert.equal(host.querySelector('.typing-time').textContent, '')
  renderer.reset()
})

test('live 思考:start 帧游标早于本步 user/message 时,流式行仍排在用户消息之后,进入思考态', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent({ type: 'turn/start', seq: 4, time: 1000, data: { turn: 1 } })
  store.applyEvent({ type: 'step/start', seq: 6, time: 1000, data: { turn: 1, step: 1 } })
  // 宿主发 start 帧时游标还停在 step/start,本步的 user/message 随后才送达。
  store.applyAssistantStreamFrame({ type: 'start', attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 6 })
  store.applyEvent({ type: 'user/message', seq: 8, time: 1000, data: { id: 'm1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } })
  store.applyAssistantStreamFrame({ type: 'chunk', attemptId: 'a', index: 0, time: 1001, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
  store.applyAssistantStreamFrame({ type: 'chunk', attemptId: 'a', index: 1, time: 1001, chunk: { type: 'reasoning-delta', index: 0, text: '想一想' } })
  const snapshot = store.getSnapshot()
  assert.deepEqual(snapshot.nodes.filter((node) => node.kind !== 'turnTail').map((node) => node.kind), ['user', 'assistant'])
  assert.equal(isThinking(snapshot), true)
  assert.equal(agentStatusLabel(snapshot), null)
  assert.equal(snapshot.runningStartTime, 1000)
})
