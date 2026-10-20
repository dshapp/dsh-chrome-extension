/**
 * 聊天记录里图片的放大查看(image-viewer.js):用户自己发送的附件图与 agent 回复
 * 里的图片(图片块 / Markdown 图片 / 工具结果图)点击后打开全屏查看器。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test, beforeEach } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Event = dom.window.Event

const { setLang } = await import('../src/shared/i18n.js')
setLang('en')
const { installImageViewer, closeImageViewer, isZoomableImage, galleryFor, _resetImageViewer } =
  await import('../src/features/chat/image-viewer.js')
const { createUserNode } = await import('../src/features/chat/node-views.js')

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function click(target) {
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
}
const viewer = () => document.querySelector('dialog.image-viewer')

beforeEach(() => {
  _resetImageViewer()
  document.body.replaceChildren()
  installImageViewer(document)
})

test('点击用户消息里的附件图打开查看器,多图可切换', () => {
  const turn = createUserNode({
    content: [
      { type: 'image', data: PNG, mediaType: 'image/png', name: 'a.png' },
      { type: 'image', data: PNG, mediaType: 'image/png', name: 'b.png' },
      { type: 'text', text: 'look' }
    ]
  })
  document.body.append(turn)
  const imgs = turn.querySelectorAll('.msg-imgs img')
  assert.equal(imgs.length, 2)
  click(imgs[1])
  const dialog = viewer()
  assert.ok(dialog?.open, 'viewer opens')
  assert.equal(dialog.querySelector('.image-viewer-img').getAttribute('src'), imgs[1].getAttribute('src'))
  assert.equal(dialog.querySelector('.image-viewer-counter').textContent, '2 / 2')
  assert.equal(dialog.querySelector('.image-viewer-caption').textContent, 'b.png')

  dialog.querySelector('.image-viewer-next').click()
  assert.equal(dialog.querySelector('.image-viewer-counter').textContent, '1 / 2')
  assert.equal(dialog.querySelector('.image-viewer-caption').textContent, 'a.png')

  dialog.querySelector('.image-viewer-close').click()
  assert.equal(dialog.open, false)
  assert.equal(dialog.querySelector('.image-viewer-img').hasAttribute('src'), false)
})

test('agent 回复里的 Markdown 图片 / 图片块 / 工具结果图都可放大', () => {
  document.body.innerHTML =
    '<div class="msg-agent md-body"><p>x</p><img src="https://example.com/a.png" alt="md"></div>' +
    '<div class="msg-img-group"><img class="msg-agent-img" src="data:image/png;base64,' + PNG + '" alt="g1">' +
    '<img class="msg-agent-img" src="data:image/png;base64,' + PNG + '" alt="g2"></div>' +
    '<div class="tool-detail"><img class="tool-result-img" src="data:image/png;base64,' + PNG + '"></div>'
  for (const img of document.querySelectorAll('img')) assert.ok(isZoomableImage(img), img.alt)

  click(document.querySelector('.md-body img'))
  assert.ok(viewer().open)
  assert.equal(viewer().querySelector('.image-viewer-counter').hidden, true, 'single image: no counter')
  closeImageViewer()
  assert.equal(viewer().open, false)

  const group = document.querySelectorAll('.msg-img-group img')
  assert.deepEqual(galleryFor(group[0]), [...group])
})

test('加载中 / 失败 / 链接里的图片 / 输入框附件不放大', () => {
  document.body.innerHTML =
    '<div class="msg-imgs"><img class="img-loading"><img class="img-failed" src="x"></div>' +
    '<div class="md-body"><a href="https://example.com"><img src="https://example.com/a.png"></a></div>' +
    '<div class="attachment-chip image"><img src="data:image/png;base64,' + PNG + '"></div>'
  for (const img of document.querySelectorAll('img')) {
    assert.equal(isZoomableImage(img), false)
    click(img)
  }
  assert.equal(viewer(), null)
})

test('键盘:方向键切换、+/-/0 缩放', () => {
  document.body.innerHTML = '<div class="context-imgs multi">' +
    '<img src="data:image/png;base64,' + PNG + '" alt="1"><img src="data:image/png;base64,' + PNG + '" alt="2"></div>'
  click(document.querySelector('.context-imgs img'))
  const dialog = viewer()
  const key = (k) => dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  key('ArrowRight')
  assert.equal(dialog.querySelector('.image-viewer-counter').textContent, '2 / 2')
  key('ArrowLeft')
  assert.equal(dialog.querySelector('.image-viewer-counter').textContent, '1 / 2')
  key('+')
  assert.ok(dialog.classList.contains('zoomed'))
  key('0')
  assert.equal(dialog.classList.contains('zoomed'), false)
})
