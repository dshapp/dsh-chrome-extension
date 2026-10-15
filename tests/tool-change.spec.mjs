/**
 * developer/message 的工具增减提示(对齐 Mac da29411 ToolChangeRow / web ContextInjectionRow):
 * 只有 tool-addition / tool-removal 块成行,其余 developer 内容不显示,也不落进未知事件兜底行。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const { createSessionStore } = await import('../src/features/sessions/session-store.js')
const { createNodeElement } = await import('../src/features/chat/node-views.js')

const developer = (seq, content) => ({
  type: 'developer/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { message: { role: 'developer', content } }
})

test('store:工具增减成 toolChange 行,其他 developer 内容不成行也不进未知兜底', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent(developer(2, [{ type: 'text', text: 'instructions' }]))
  store.applyEvent(developer(3, [
    { type: 'tool-addition', toolName: 'a' },
    { type: 'tool-addition', toolName: 'b' },
    { type: 'tool-removal', toolName: 'c' }
  ]))
  const nodes = store.getSnapshot().nodes ?? []
  assert.equal(nodes.filter((node) => node.kind === 'unknownSurface').length, 0)
  const changes = nodes.filter((node) => node.kind === 'toolChange')
  assert.equal(changes.length, 1)
  assert.deepEqual([changes[0].added, changes[0].removed], [['a', 'b'], ['c']])
})

test('渲染:单个变更是纯提示;多个变更是可点开的「工具已更新」+ 计数', () => {
  const single = createNodeElement({ kind: 'toolChange', seq: 1, added: ['x'], removed: [] })
  assert.match(single.textContent, /x/)
  assert.equal(single.querySelector('button'), null)
  const multi = createNodeElement({ kind: 'toolChange', seq: 2, added: ['a', 'b'], removed: ['c'] })
  assert.ok(multi.querySelector('button.chip-head'))
  assert.ok(multi.querySelector('.tool-change-count')?.textContent)
})
