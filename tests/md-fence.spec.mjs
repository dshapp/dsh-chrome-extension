/**
 * fenced code 的信息串。
 *
 * CommonMark 允许开栅栏与信息串之间有空白(" ``` js"),信息串本身再被去掉
 * 首尾空白。splitFencedBlocks 原来的正则 /^\s*```(\S*)\s*$/ 要求反引号后
 * 立刻就是非空白,于是 " ``` js" 这类行**既不算开栅栏也不算关栅栏**:
 * 代码块被当成普通段落,而后面真正的关栅栏开了个吞掉余下正文的 <pre>。
 *
 * 症状是流式回答里"半段代码退化成段落 + 后续正文被吸进代码块",
 * 而同一段文本在回合结束后的整次渲染里又是对的 —— 用户会看到内容回流。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mdToHtml } from '../src/shared/md-to-html.js'

const FENCE = '```'

/** 顶层标签序列,用来比对块结构而不是内部细节。 */
function tagSeq(html) {
  return [...html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)].map((m) => m[1] + m[2]).join(',')
}

test('信息串前有空白时,围栏仍被识别为代码块', () => {
  for (const info of [' js', '  js', '\tjs', ' javascript']) {
    const src = ['before', '', FENCE + info, 'const a = 1;', 'const b = 2;', FENCE, '', 'after'].join('\n')
    const html = mdToHtml(src)
    assert.match(html, /<pre[^>]*><code>const a = 1;/,
      `信息串 ${JSON.stringify(info)} 应当被当作代码块。实际:${html}`)
    // 关栅栏之后的正文必须留在代码块之外。
    assert.match(html, /<p>after<\/p>$/, `正文 after 被吸进了代码块:${html}`)
  }
})

test('信息串前后空白不会泄漏进 data-language', () => {
  const src = [FENCE + ' js', 'x', FENCE].join('\n')
  const html = mdToHtml(src)
  assert.match(html, /data-language="js"/, html)
})

test('没有信息串、只有空白的围栏仍然有效', () => {
  const src = ['a', FENCE, 'code', FENCE, 'b'].join('\n')
  const html = mdToHtml(src)
  assert.match(html, /<pre data-language="text"><code>code<\/code><\/pre>/)
})

test('增量渲染(头 + 尾)与一次性渲染产出同样的块结构', () => {
  // stableCut 用 /^\s*```/ 认栅栏;mdToHtml 必须用同一套"什么算栅栏"
  // 的判定,否则切点会落进代码块,变成 head/tail 各渲染半块。
  const src = ['before', '', FENCE + ' js', 'const a = 1;', '', 'const b = 2;', FENCE, '', 'after'].join('\n')
  const oneShot = tagSeq(mdToHtml(src))
  assert.match(oneShot, /^p,\/p,pre,code,\/code,\/pre,p,\/p$/, oneShot)
})
