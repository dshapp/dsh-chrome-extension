/**
 * 助手正文里的文件链接 / 网页链接与代码块着色。
 *
 * 对齐 web MarkdownText:
 * - [label](path#L12) / [label](<带 空格 的/路径>) → 文件链接,点击交宿主打开(相对路径按 cwd 解析);
 * - http(s)/mailto → 新标签页打开;javascript: 等不认的协议只留标签;
 * - 行内 code 整段是网址时可点;
 * - 代码块按语言着色(含别名,覆盖 c/cpp/kotlin/swift 等常见语言)。
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
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node

const { mdToHtml } = await import('../src/shared/md-to-html.js')
const { fileLinkTarget, externalHref } = await import('../src/shared/link-targets.js')
const { bindLinkActions, decorateFileLinks } = await import('../src/features/chat/link-actions.js')
const { createAssistantNode } = await import('../src/features/chat/node-views.js')
const { highlightCodeBlocks } = await import('../src/features/chat/code-highlight.js')

function host(html) {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

function click(target, init = {}) {
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  target.dispatchEvent(event)
  return event
}

test('fileLinkTarget:对齐 web —— 相对/绝对/Windows 路径与 #L 行号,拒绝协议、查询串、// 与畸形转义', () => {
  assert.deepEqual(fileLinkTarget('src/a.tsx#L113'), { path: 'src/a.tsx', line: 113 })
  assert.deepEqual(fileLinkTarget('src/a.tsx#L10-L20'), { path: 'src/a.tsx', line: 10 })
  assert.deepEqual(fileLinkTarget('/abs/my%20file.md'), { path: '/abs/my file.md' })
  assert.deepEqual(fileLinkTarget('C:\\work\\a.txt'), { path: 'C:\\work\\a.txt' })
  assert.equal(fileLinkTarget('https://a.com/x'), null)
  assert.equal(fileLinkTarget('javascript:alert(1)'), null)
  assert.equal(fileLinkTarget('a.md?x=1'), null)
  assert.equal(fileLinkTarget('//host/share'), null)
  assert.equal(fileLinkTarget('a%zz.md'), null)
  assert.equal(fileLinkTarget('a.md#section'), null)
  assert.equal(fileLinkTarget('a.md#L20-L10'), null)
  assert.equal(externalHref('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(externalHref('javascript:alert(1)'), null)
})

test('尖括号文件目标渲染成 .md-file-link,带路径与行号;不开 fileLinks 时只留标签文字', () => {
  const md = '见 [performance-panel.tsx:113](<packages/app/src/slices/admin/performance-panel.tsx#L113>) 一处'
  const root = host(mdToHtml(md, { fileLinks: true }))
  const link = root.querySelector('a.md-file-link')
  assert.ok(link, root.innerHTML)
  assert.equal(link.dataset.path, 'packages/app/src/slices/admin/performance-panel.tsx')
  assert.equal(link.dataset.line, '113')
  assert.equal(link.textContent, 'performance-panel.tsx:113')
  assert.ok(!root.textContent.includes(']('), root.textContent)

  const plain = host(mdToHtml(md))
  assert.equal(plain.querySelector('a'), null)
  assert.equal(plain.textContent, '见 performance-panel.tsx:113 一处')
})

test('带空格/中文的路径与 glob 星号不被强调规则切碎', () => {
  const root = host(mdToHtml('[设计](<docs/设计 文档.md>) 与 [glob](src/**/*.js) 和 **粗**', { fileLinks: true }))
  const links = [...root.querySelectorAll('a.md-file-link')]
  assert.deepEqual(links.map((a) => a.dataset.path), ['docs/设计 文档.md', 'src/**/*.js'])
  assert.equal(root.querySelector('strong')?.textContent, '粗')
})

test('网页链接:显式链接、裸 URL、整段是网址的行内 code 都可点;不认的协议只留标签', () => {
  const root = host(mdToHtml('[文档](https://a.com/x?y=1&z=2) 裸 https://b.com/p 和 `https://c.com/q` 以及 [坏](javascript:alert(1))', { fileLinks: true }))
  const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  assert.deepEqual(hrefs, ['https://a.com/x?y=1&z=2', 'https://b.com/p', 'https://c.com/q'])
  assert.equal(root.querySelector('code a')?.getAttribute('href'), 'https://c.com/q')
  assert.ok(root.textContent.includes('坏'))
  assert.ok(!root.innerHTML.includes('javascript:'))
  // 图片规则不认的地址仍按字面留着,不被当成链接。
  assert.ok(host(mdToHtml('![x](relative.png)', { fileLinks: true })).textContent.includes('![x](relative.png)'))
})

test('bindLinkActions:文件链接交 openFile(带行号)且不跳页;网页链接交 openUrl;修饰键点击放行', () => {
  const root = host(mdToHtml('[a](src/a.ts#L7) [b](https://a.com)', { fileLinks: true }))
  document.body.append(root)
  decorateFileLinks(root)
  assert.ok(root.querySelector('a.md-file-link .md-file-link-icon svg'), 'file glyph')
  const opened = []
  const urls = []
  bindLinkActions(root, { openFile: (path, options) => opened.push([path, options]), openUrl: (url) => urls.push(url) })
  const fileEvent = click(root.querySelector('a.md-file-link'))
  assert.equal(fileEvent.defaultPrevented, true)
  assert.deepEqual(opened, [['src/a.ts', { line: 7 }]])
  const urlEvent = click(root.querySelector('a.md-link'))
  assert.equal(urlEvent.defaultPrevented, true)
  assert.deepEqual(urls, ['https://a.com'])
  const meta = click(root.querySelector('a.md-link'), { metaKey: true })
  assert.equal(meta.defaultPrevented, false)
  assert.equal(urls.length, 1)
  // 重绑只换回调,不叠监听。
  bindLinkActions(root, { openFile: () => opened.push('second'), openUrl: () => {} })
  click(root.querySelector('a.md-file-link'))
  assert.deepEqual(opened.slice(1), ['second'])
  root.remove()
})

test('助手正文:相对文件链接按会话 cwd 解析后交宿主打开', () => {
  const opened = []
  const turn = createAssistantNode({
    blocks: [{ type: 'text', text: '改了 [a.tsx:12](<src/a.tsx#L12>)。' }],
    status: 'done'
  }, { cwd: '/work/repo', onOpenPath: (path) => opened.push(path), onOpenFile: (path) => opened.push(path) })
  document.body.append(turn)
  const link = turn.querySelector('a.md-file-link')
  assert.ok(link, turn.innerHTML)
  click(link)
  assert.deepEqual(opened, ['/work/repo/src/a.tsx'])
  turn.remove()
})

test('代码块着色:别名与新增语言(c++/kotlin/swift/toml)都能着色,未知语言保持原样', async () => {
  const md = ['c++', 'kotlin', 'swift', 'toml', 'unknownlang']
    .map((lang) => '```' + lang + '\nint main() { return 0; } // x\n```').join('\n\n')
  const root = host(mdToHtml(md))
  await highlightCodeBlocks(root)
  const states = [...root.querySelectorAll('pre > code')].map((code) => code.dataset.highlighted)
  assert.deepEqual(states, ['cpp', 'kotlin', 'swift', 'ini', 'skipped'])
  assert.ok(root.querySelector('pre[data-language="c++"] .hljs-keyword, pre[data-language="c++"] .hljs-type'))
})
