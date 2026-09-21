/**
 * 插件注入的上下文(tools-ptc 等)里的图片必须在记录流里出图。
 *
 * 症状:一条只带截图的注入消息,行上只有一枚 "tools-ptc" 标签 + 一句 "[image]"
 * 文字 —— 图片被 blocksToText 折成占位符,整张图在会话记录里看不见。
 * Mac 的 ContextRow 早已改成行内 MessageGallery,这里把同样的契约钉在扩展侧:
 *   1. 行内真的挂出 <img>,并按 attachmentId 读回字节;
 *   2. 摘要文字里不再出现 "[image]" 占位符;
 *   3. 文本 + 图片混排时,文本摘要照常显示。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
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

const { createContextNode } = await import('../src/features/chat/node-views.js')

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function imageBlock(attachmentId) {
  return { type: 'image', attachment: { attachmentId, mediaType: 'image/png', name: 'shot.png' } }
}

function render(content, { reads = [] } = {}) {
  return createContextNode(
    { kind: 'context', content, provenanceLabel: 'tools-ptc', provenanceRole: 'context' },
    {
      readAttachment: async (id) => {
        reads.push(id)
        return { data: 'QUJD', attachment: { mediaType: 'image/png' } } // "ABC"
      }
    }
  )
}

test('纯图片的注入消息行内出图,而不是一行 [image] 文字', async () => {
  const reads = []
  const row = render([imageBlock('att-1')], { reads })
  await flush()

  const images = row.querySelectorAll('img')
  assert.equal(images.length, 1, '行上必须真的挂出一个 <img>')
  assert.equal(images[0].src, 'data:image/png;base64,QUJD', '附件字节必须读回并落到 src')
  assert.deepEqual(reads, ['att-1'], '按 attachmentId 读回一次')
  assert.equal(row.querySelector('.context-preview').textContent, '',
    '摘要里不该再出现 [image] 占位符')
  assert.equal(row.querySelector('.context-label').textContent, 'tools-ptc')
})

test('多张图片退成缩略图网格', async () => {
  const row = render([imageBlock('a'), imageBlock('b'), imageBlock('c')])
  await flush()
  assert.equal(row.querySelectorAll('img').length, 3)
  assert.ok(row.querySelector('.context-imgs').classList.contains('multi'),
    '多图要走缩略图排布,否则三张大图会把记录流撑开')
})

test('文本 + 图片混排:摘要显示文本,图片照常出图', async () => {
  const row = render([{ type: 'text', text: '截图如下' }, imageBlock('att-2')])
  await flush()
  assert.equal(row.querySelector('.context-preview').textContent, '截图如下')
  assert.equal(row.querySelectorAll('img').length, 1)
})

test('没有图片时行为不变:只有标签 + 文本摘要', async () => {
  const row = render([{ type: 'text', text: '注入的说明' }])
  await flush()
  assert.equal(row.querySelectorAll('img').length, 0)
  assert.equal(row.querySelector('.context-imgs'), null)
  assert.equal(row.querySelector('.context-preview').textContent, '注入的说明')
})
