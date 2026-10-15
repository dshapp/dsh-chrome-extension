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

const { createChatRenderer } = await import('../src/features/chat/chat-renderer.js')
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
