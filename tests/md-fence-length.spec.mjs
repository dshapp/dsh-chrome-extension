/**
 * 围栏长度:4 个反引号的代码块里可以写 ``` 行。
 *
 * splitFencedBlocks 与 stableCut 原来只认 "以三个反引号开头",不记开栅栏的
 * 反引号个数。CommonMark 规定关栅栏不能短于开栅栏,所以
 *
 *     ````
 *     ```
 *     ````
 *
 * 是**一个**代码块,内容是一行 ```。原实现里中间那行被当成关栅栏,末尾那行
 * 又被当成新的开栅栏,余下正文全被吸进一个未闭合的 <pre> —— 用户看到"示范
 * 怎么写围栏"的答案后半段变成代码。
 *
 * 关栅栏也不能带信息串:代码块内的 "```js" 是内容,不是结束。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mdToHtml } from '../src/shared/md-to-html.js'
import { stableCut } from '../src/features/chat/incremental-markdown.js'

const F3 = '```'
const F4 = '````'

/** 顶层标签序列,用来比对块结构而不是内部细节。 */
function tagSeq(html) {
  return [...html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)].map((m) => m[1] + m[2]).join(',')
}

test('4 个反引号的围栏不会被内部的 ``` 行关掉', () => {
  const src = [F4, F3, F4, '', 'after'].join('\n')
  const html = mdToHtml(src)
  assert.equal((html.match(/<pre/g) || []).length, 1,
    `应当只有一个代码块,实际 ${(html.match(/<pre/g) || []).length} 个:${html}`)
  assert.match(html, /<pre[^>]*><code>```<\/code><\/pre>/, html)
  assert.match(html, /<p>after<\/p>$/, `正文 after 被吸进了代码块:${html}`)
})

test('关栅栏短于开栅栏时不算关闭', () => {
  const src = [F4, 'content', F3, 'still code', F4, '', 'after'].join('\n')
  const html = mdToHtml(src)
  assert.equal((html.match(/<pre/g) || []).length, 1, html)
  assert.match(html, /<p>after<\/p>$/, html)
  assert.match(html, /still code/, html)
})

test('关栅栏带信息串时不关闭代码块', () => {
  const src = [F3, 'a', F3 + 'js', 'b', F3, '', 'after'].join('\n')
  const html = mdToHtml(src)
  assert.equal((html.match(/<pre/g) || []).length, 1, html)
  assert.match(html, /<p>after<\/p>$/, html)
  assert.match(html, /```js\nb/, '带信息串的那行应当留在代码内容里:' + html)
})

test('stableCut 不会把切点落进 4 个反引号的代码块里', () => {
  // 切点若落进代码块,head/tail 会各渲染半块。
  const src = [F4, '', 'inner', F3, '', 'tail code', F4, '', 'after'].join('\n')
  const cut = stableCut(src, 1)
  if (cut != null) {
    const head = mdToHtml(src.slice(0, cut))
    // 切点必须落在代码块**之外**:head 里的 <pre> 要么没有,要么成对闭合。
    // 一个未闭合的 <pre> 说明切点落进了代码块。
    const opens = (head.match(/<pre/g) || []).length
    const closes = (head.match(/<\/pre>/g) || []).length
    assert.equal(opens, closes,
      `切点 ${cut} 落在代码块内部(${opens} 个 <pre> 只闭合了 ${closes} 个):${head}`)
    assert.equal(opens, 1, `head 应当含一个已闭合的代码块,实际 ${opens}:${head}`)
  }
})

test('增量渲染与一次性渲染的块结构一致(4 反引号 + 嵌套 ```)', () => {
  const src = [F4, F3, '', F3, F4, '', 'after'].join('\n')
  const oneShot = tagSeq(mdToHtml(src))
  assert.equal(oneShot, 'pre,code,/code,/pre,p,/p', oneShot)
})
