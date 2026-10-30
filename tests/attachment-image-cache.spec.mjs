/**
 * 历史图片缓存必须有上限。
 *
 * applyImageSource 把读回的附件缓存成 entry.url = "data:image/png;base64,...",
 * 而 attachmentImageCache 是模块级 Map —— 无上限累积等于把这段会话里渲染过的
 * 每一张图(整张 base64)都钉死在内存里,永不释放。长会话 + 多截图时是实打实的
 * 内存增长。这里把"缓存被裁剪到上限以内"钉住,同时也确认淘汰不是简单地不缓存:
 * 被淘汰的图再次渲染时会重新读,最近用过的图不会重复读。
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

const { createUserNode, attachmentImageCacheSize, ATTACHMENT_IMAGE_CACHE_LIMIT } =
  await import('../src/features/chat/node-views.js')

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function renderImage(attachmentId, counts) {
  const context = {
    readAttachment: async ({ attachmentId: id }) => {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      return { data: 'QUJD', attachment: { mediaType: 'image/png' } } // "ABC"
    }
  }
  return createUserNode({
    id: 'n-' + attachmentId,
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png' } }]
  }, context)
}

test('渲染远超上限的图片后,缓存被裁剪到上限以内', async () => {
  const counts = new Map()
  for (let i = 0; i < ATTACHMENT_IMAGE_CACHE_LIMIT * 2; i++) renderImage('img-' + i, counts)
  await flush()
  assert.ok(attachmentImageCacheSize() <= ATTACHMENT_IMAGE_CACHE_LIMIT,
    `缓存必须被裁剪到 ${ATTACHMENT_IMAGE_CACHE_LIMIT} 以内,实际 ${attachmentImageCacheSize()}`)
  assert.equal(counts.size, ATTACHMENT_IMAGE_CACHE_LIMIT * 2, '每张图仍应被读到一次')
})

test('同一张图重复渲染只读一次(命中缓存)', async () => {
  const counts = new Map()
  renderImage('repeat', counts)
  await flush()
  renderImage('repeat', counts)
  await flush()
  assert.equal(counts.get('repeat'), 1, '命中缓存不该重读')
})

test('被淘汰的老图再次渲染会重新读(淘汰 ≠ 不缓存)', async () => {
  const counts = new Map()
  const oldest = 'evict-me'
  renderImage(oldest, counts)
  await flush()
  assert.equal(counts.get(oldest), 1)
  // 挤爆缓存,把 oldest 挤出去
  for (let i = 0; i < ATTACHMENT_IMAGE_CACHE_LIMIT + 5; i++) renderImage('filler-' + i, counts)
  await flush()
  assert.ok(attachmentImageCacheSize() <= ATTACHMENT_IMAGE_CACHE_LIMIT)
  renderImage(oldest, counts)
  await flush()
  assert.equal(counts.get(oldest), 2, '被淘汰的图必须能重新读回,否则用户会看到永久失败的图')
})
