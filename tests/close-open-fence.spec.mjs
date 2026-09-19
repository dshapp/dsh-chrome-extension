/**
 * 折叠切点补围栏时要补**正确长度**的围栏。
 *
 * node-views 的 closeOpenFence 在"折叠切点落在未闭合围栏里"时补一行围栏收尾,
 * 免得余下正文被吞进代码块。它原来固定补三个反引号,且用 /^\s*```/ 数围栏
 * —— 开栅栏是四个反引号时,补出来的 ``` 关不掉它,反而变成代码块里多出来
 * 的一行 "```",用户会看到预览尾部凭空冒出一个围栏。
 *
 * 判定要与 md-to-html 的 readFence/isClosingFence 一致,关栅栏长度取开栅栏长度。
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

const { mdToHtml } = await import('../src/shared/md-to-html.js')
// 测真实实现,不是测试文件里的副本。
const { closeOpenFence } = await import('../src/features/chat/node-views.js')

const F3 = '```'
const F4 = '````'

test('折叠切点落在 4 反引号围栏内时,补出的是 4 个反引号', () => {
  const preview = [F4, 'some code'].join('\n')
  const closed = closeOpenFence(preview)
  assert.equal(closed, preview + '\n' + F4,
    '关栅栏必须与开栅栏等长,否则关不掉它')
})

test('补出来的围栏不会在代码块里留下多余的反引号行', () => {
  const preview = [F4, 'some code'].join('\n')
  const html = mdToHtml(closeOpenFence(preview))
  assert.doesNotMatch(html, /some code\n```/,
    '补的围栏变成了代码内容:' + html)
  assert.match(html, /<pre[^>]*><code>some code<\/code><\/pre>/, html)
})

test('三个反引号的情形仍然补三个', () => {
  const preview = [F3, 'some code'].join('\n')
  assert.equal(closeOpenFence(preview), preview + '\n' + F3)
})

test('已经闭合的围栏不补', () => {
  const src = [F4, 'code', F4, '', 'after'].join('\n')
  assert.equal(closeOpenFence(src), src)
  const src3 = [F3, 'code', F3].join('\n')
  assert.equal(closeOpenFence(src3), src3)
})

test('围栏外的普通文本不补', () => {
  const src = ['plain text', 'more', ''].join('\n')
  assert.equal(closeOpenFence(src), src)
})
