import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createSessionStore } from '../src/features/sessions/session-store.js'
import { createChatRenderer } from '../src/features/chat/chat-renderer.js'
import { thinkingSummary } from '../src/features/chat/node-views.js'
import { setLang } from '../src/shared/i18n.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement })
setLang('zh')

test('running summary rotates to the latest paragraph whose first line has completed (web parity)', () => {
  assert.equal(thinkingSummary('正在写第一行', true), '')
  assert.equal(thinkingSummary('第一段首行\n还在写', true), '第一段首行')
  assert.equal(thinkingSummary('第一段首行\n正文\n\n第二段还在写', true), '第一段首行')
  assert.equal(thinkingSummary('第一段首行\n正文\n\n  **第二段**首行 \n', true), '第二段首行')
  assert.equal(thinkingSummary('A\r\n \t\r\nB\nC\n\n', true), 'B')
  assert.equal(thinkingSummary('A\n\n   \n', true), 'A')
})

test('settled summary is the raw first line without bold markers', () => {
  assert.equal(thinkingSummary('**计划**:先读代码\n然后\n\n再改', false), '计划:先读代码')
  assert.equal(thinkingSummary('\n第二行', false), '')
  assert.equal(thinkingSummary('', false), '')
})

test('thinking row renders "思考 · summary" and shimmers only while streaming', () => {
  const store = createSessionStore(); store.reset('s'); store.setCwd('/p')
  store.applyEvent({ seq: 0, type: 'turn/start', data: { turn: 1 }, time: 0 })
  store.applyAssistantStreamFrame({ type: 'start', attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 0 })
  const chunk = (c) => store.applyAssistantStreamFrame({ type: 'chunk', attemptId: 'a', chunk: c, time: 1000 })
  chunk({ type: 'block-start', index: 0, blockType: 'reasoning' })
  const container = document.createElement('div'); const renderer = createChatRenderer(container)
  const row = () => container.querySelector('.thinking-bubble')
  const visible = (sel) => row().classList.contains('has-preview') || !/thinking-(sep|title)/.test(sel)

  chunk({ type: 'reasoning-delta', index: 0, text: '分析需求' })
  renderer.render(store.getSnapshot().nodes)
  assert.ok(row().classList.contains('running'))
  assert.equal(row().querySelector('.thinking-name').textContent, '思考')
  assert.equal(row().classList.contains('has-preview'), false)
  assert.equal(visible('.thinking-title'), false)

  chunk({ type: 'reasoning-delta', index: 0, text: '\n细节\n\n第二步' })
  renderer.render(store.getSnapshot().nodes)
  assert.equal(row().querySelector('.thinking-title').textContent, '分析需求')
  assert.ok(row().classList.contains('has-preview'))

  chunk({ type: 'reasoning-delta', index: 0, text: '\n继续' })
  renderer.render(store.getSnapshot().nodes)
  assert.equal(row().querySelector('.thinking-title').textContent, '第二步')
  assert.equal(row().querySelector('.thinking-header').getAttribute('aria-label'), '思考 第二步')

  chunk({ type: 'block-start', index: 1, blockType: 'text' })
  chunk({ type: 'text-delta', index: 1, text: '答案' })
  renderer.render(store.getSnapshot().nodes)
  assert.equal(row().classList.contains('running'), false)
  assert.equal(row().querySelector('.thinking-title').textContent, '分析需求')
})
