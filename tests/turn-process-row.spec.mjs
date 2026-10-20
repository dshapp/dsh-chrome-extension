/**
 * 轮次折叠头(对齐 Mac TurnProcessRow):文案 "已完成，用时 35分53秒",
 * chevron 紧跟在文字右侧,下面一条分割线。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement })

const { setLang } = await import('../src/shared/i18n.js')
const { createTurnProcessNode } = await import('../src/features/chat/node-views.js')

const spec = (over = {}) => ({ kind: 'turnProcess', turn: 3, foldEndSeq: 10, memberCount: 4, outcome: 'completed', durationMs: (35 * 60 + 53) * 1000, ...over })

test('完成:文案与 Mac 一致,chevron 在文字右侧,下方有分割线', () => {
  setLang('zh')
  const row = createTurnProcessNode(spec())
  assert.equal(row.tagName, 'BUTTON')
  assert.equal(row.querySelector('.turn-process-label').textContent, '已完成，用时 35分53秒')
  const heading = row.querySelector('.turn-process-heading')
  assert.deepEqual([...heading.children].map((c) => c.className), ['turn-process-label', 'turn-process-chevron'])
  assert.equal(row.lastElementChild.className, 'turn-process-divider')
  setLang('en')
  assert.equal(createTurnProcessNode(spec()).querySelector('.turn-process-label').textContent, 'Completed in 35m 53s')
  setLang('zh')
})

test('用时下限 1 秒;没有起点只说已完成;停止/失败不带用时也不可折叠', () => {
  setLang('zh')
  assert.equal(createTurnProcessNode(spec({ durationMs: 200 })).querySelector('.turn-process-label').textContent, '已完成，用时 1秒')
  assert.equal(createTurnProcessNode(spec({ durationMs: null })).querySelector('.turn-process-label').textContent, '已完成')
  const stopped = createTurnProcessNode(spec({ outcome: 'stopped', foldEndSeq: null }))
  assert.equal(stopped.tagName, 'DIV')
  assert.equal(stopped.querySelector('.turn-process-label').textContent, '已停止')
  assert.equal(stopped.querySelector('.turn-process-chevron'), null)
  assert.ok(stopped.querySelector('.turn-process-divider'))
  assert.equal(createTurnProcessNode(spec({ outcome: 'failed', foldEndSeq: null })).querySelector('.turn-process-label').textContent, '处理失败')
})
