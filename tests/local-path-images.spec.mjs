/**
 * 助手正文里的本地绝对路径图片(dsh 0.1.7)。
 *
 * 对齐 web AssistantMarkdown.localPathMediaUrl 及其测试
 * assistant-markdown-path-images.client.spec.tsx、Mac 7d3e1cd:
 * - 只放行以 "/" 开头且不是 "//" 的地址;相对路径、file://、Windows 路径保持原样文字。
 * - 只有助手正文(localImages 模式)产出占位图,其余 mdToHtml 调用点行为不变。
 * - 占位图经宿主 GET /api/file?path=… 读成 blob: 挂上;失败换成 alt 文字(alt 空则原路径)。
 * - api-client.getBlob 带 cookie、走 401 重试,path 按 URLSearchParams 编码。
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

const { isLocalImagePath, isSafeImageSrc } = await import('../src/shared/image-src.js')
const { mdToHtml } = await import('../src/shared/md-to-html.js')
const { hydrateLocalImages, localImageCacheSize, LOCAL_IMAGE_CACHE_LIMIT, sniffImageType } =
  await import('../src/features/chat/local-images.js')
const { renderIncrementalMarkdown } = await import('../src/features/chat/incremental-markdown.js')
const { createApiClient } = await import('../src/platform/dsh/api-client.js')

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

function host(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

test('isLocalImagePath 与 web localPathMediaUrl 同规则', () => {
  assert.equal(isLocalImagePath('/tmp/graph.png'), true)
  assert.equal(isLocalImagePath('/Users/a/b c.png'), true)
  for (const value of ['', 'relative.png', './a.png', '//cdn.example.com/x.png',
    'file:///tmp/x.png', 'C:\\tmp\\x.png', 'https://a.com/x.png', '/tmp/a\u0000.png', '/tmp/\n.png']) {
    assert.equal(isLocalImagePath(value), false, value)
  }
  // 安全边界不变:本地路径不会被 isSafeImageSrc 直接放进 src。
  assert.equal(isSafeImageSrc('/tmp/graph.png'), false)
})

test('默认模式下本地路径图片仍按字面文字输出', () => {
  const html = mdToHtml('See ![diagram](/tmp/graph.png) here')
  assert.ok(!html.includes('<img'), html)
  assert.ok(html.includes('![diagram](/tmp/graph.png)'), html)
})

test('localImages 模式产出无 src 的占位图,非绝对路径保持文字', () => {
  const html = mdToHtml('See ![dia"g](/tmp/a&b.png) and ![x](relative.png) and ![y](//h/x.png)',
    { localImages: true })
  const root = host(html)
  const imgs = root.querySelectorAll('img')
  assert.equal(imgs.length, 1)
  const img = imgs[0]
  assert.equal(img.hasAttribute('src'), false)
  assert.equal(img.getAttribute('data-local-path'), '/tmp/a&b.png')
  assert.equal(img.alt, 'dia"g')
  assert.ok(root.textContent.includes('![x](relative.png)'))
  assert.ok(root.textContent.includes('![y](//h/x.png)'))
  // https 图片不受影响。
  assert.ok(mdToHtml('![r](https://a.com/x.png)', { localImages: true }).includes('src="https://a.com/x.png"'))
})

test('尖括号目标 ![alt](</abs/path>) 与 Mac/web(CommonMark)一样渲染成图片', () => {
  // 回归:截图里 ![Jira 看板](</tmp/shots/04-after-kanban-board.jpg>) 原样显示成文字。
  const root = host(mdToHtml('![Jira 看板](</tmp/shots/04-after-kanban-board.jpg>)', { localImages: true }))
  const img = root.querySelector('img')
  assert.ok(img, root.innerHTML)
  assert.equal(img.getAttribute('data-local-path'), '/tmp/shots/04-after-kanban-board.jpg')
  assert.equal(img.alt, 'Jira 看板')
  assert.ok(!root.textContent.includes('</tmp'), root.textContent)

  // 尖括号里允许空格;https 同样认;可选 title 不让整段退化成文字。
  const spaced = host(mdToHtml('![a](</Users/me/My Shots/图 1.png>)', { localImages: true }))
  assert.equal(spaced.querySelector('img').getAttribute('data-local-path'), '/Users/me/My Shots/图 1.png')
  assert.ok(mdToHtml('![r](<https://a.com/x.png>)').includes('src="https://a.com/x.png"'))
  const titled = host(mdToHtml('![t](/tmp/t.png "标题") ![u](</tmp/u.png> \'x\')', { localImages: true }))
  assert.deepEqual([...titled.querySelectorAll('img')].map((i) => i.getAttribute('data-local-path')),
    ['/tmp/t.png', '/tmp/u.png'])

  // 尖括号里不能再有尖括号/换行;默认模式下仍是文字。
  assert.equal(host(mdToHtml('![x](</tmp/<a>.png>)', { localImages: true })).querySelector('img'), null)
  assert.ok(!mdToHtml('![x](</tmp/a.png>)').includes('<img'))
})

test('本地路径与 web localPathMediaUrl / Mac url.path 一样做百分号解码并去掉 ?#', () => {
  const paths = (md) => [...host(mdToHtml(md, { localImages: true })).querySelectorAll('img')]
    .map((i) => i.getAttribute('data-local-path'))
  assert.deepEqual(paths('![a](/work/test%20workspace/%E5%9B%BE.png)'), ['/work/test workspace/图.png'])
  assert.deepEqual(paths('![a](/work/literal%2520.png)'), ['/work/literal%20.png'])
  assert.deepEqual(paths('![a](/tmp/x.png?v=1#frag)'), ['/tmp/x.png'])
  // 解码出的引号不能逃出属性。
  assert.deepEqual(paths('![a](/tmp/%22q%22.png)'), ['/tmp/"q".png'])
  // 畸形转义、解码出控制字符:不认,保持文字。
  assert.deepEqual(paths('![a](/tmp/%E0%A4%A.png)'), [])
  assert.deepEqual(paths('![a](/tmp/%00.png)'), [])
})

test('增量渲染对尖括号本地图也会读回', async () => {
  const calls = []
  const box = document.createElement('div')
  renderIncrementalMarkdown(box, '看板:\n\n![Jira 看板](</tmp/inc-angle.jpg>)', {
    loadLocalImage: async (p) => { calls.push(p); return png() }
  })
  await flush()
  assert.ok(box.querySelector('img').src.startsWith('blob:'))
  assert.deepEqual(calls, ['/tmp/inc-angle.jpg'])
})

test('占位图被读成 blob: 并挂上;同路径命中缓存只读一次', async () => {
  const calls = []
  const load = async (path) => { calls.push(path); return png() }
  const a = host(mdToHtml('![a](/tmp/hit.png)', { localImages: true }))
  hydrateLocalImages(a, load)
  await flush()
  const img = a.querySelector('img')
  assert.ok(img.src.startsWith('blob:'), img.src)
  assert.equal(img.hasAttribute('data-local-path'), false, '处理过的占位不再被重扫')

  const b = host(mdToHtml('行内 ![b](/tmp/hit.png) 图', { localImages: true }))
  hydrateLocalImages(b, load)
  assert.ok(b.querySelector('img').src.startsWith('blob:'), '命中缓存应同步挂上')
  assert.deepEqual(calls, ['/tmp/hit.png'])
})

test('读取失败或非图片时换成 alt 文字(alt 为空显示原路径)', async () => {
  const root = host(mdToHtml('![图注](/tmp/missing.png)\n\n![](/tmp/empty-alt.png)\n\n![t](/tmp/a.txt)',
    { localImages: true }))
  hydrateLocalImages(root, async (path) => {
    if (path === '/tmp/a.txt') return new Blob(['hi'], { type: 'text/plain' })
    return null // 404
  })
  await flush()
  assert.equal(root.querySelectorAll('img').length, 0)
  const alts = [...root.querySelectorAll('.md-img-alt')].map((node) => node.textContent)
  assert.deepEqual(alts, ['图注', '/tmp/empty-alt.png', 't'])
})

test('无扩展名的附件对象(宿主回 octet-stream)按文件头识别成图片,与 web/Mac 一致', async () => {
  // 回归:![…](</Users/u/.dsh/attachments/v1/objects/80/80523a…>) 在扩展里只剩 alt 文字,
  // 宿主按扩展名给 MIME,无扩展名 → application/octet-stream。
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const created = []
  const original = URL.createObjectURL
  URL.createObjectURL = (blob) => { created.push(blob); return original.call(URL, blob) }
  try {
    const root = host(mdToHtml(
      '![Selector](</Users/u/.dsh/attachments/v1/objects/80/80523a84ba40b9b6>)\n\n![bin](/tmp/octet.bin)',
      { localImages: true }))
    hydrateLocalImages(root, async (path) => path.endsWith('.bin')
      ? new Blob(['plain text'], { type: 'application/octet-stream' })
      : new Blob([jpeg], { type: 'application/octet-stream' }))
    for (let i = 0; i < 5; i++) { await flush(); await new Promise((r) => setTimeout(r, 0)) }
    const img = root.querySelector('img')
    assert.ok(img && img.src.startsWith('blob:'), root.innerHTML)
    assert.equal(img.alt, 'Selector')
    assert.equal(created.length, 1)
    assert.equal(created[0].type, 'image/jpeg')
    assert.deepEqual([...root.querySelectorAll('.md-img-alt')].map((n) => n.textContent), ['bin'])
  } finally {
    URL.createObjectURL = original
  }
})

test('sniffImageType 认 WHATWG 位图签名,其余为 null', () => {
  const b = (...xs) => new Uint8Array(xs)
  assert.equal(sniffImageType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png')
  assert.equal(sniffImageType(b(0xff, 0xd8, 0xff, 0xdb)), 'image/jpeg')
  assert.equal(sniffImageType(new TextEncoder().encode('GIF89a..')), 'image/gif')
  assert.equal(sniffImageType(new TextEncoder().encode('RIFF\u0001\u0002\u0003\u0004WEBPVP8 ')), 'image/webp')
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffImageType(b(0x89, 0x50)), null)
  assert.equal(sniffImageType(b()), null)
})

test('缓存有上限,淘汰时 revoke blob URL', async () => {
  const revoked = []
  const original = URL.revokeObjectURL
  URL.revokeObjectURL = (url) => { revoked.push(url); return original.call(URL, url) }
  try {
    for (let i = 0; i < LOCAL_IMAGE_CACHE_LIMIT + 8; i++) {
      hydrateLocalImages(host(mdToHtml(`![i](/tmp/cap-${i}.png)`, { localImages: true })), async () => png())
      await flush()
    }
    assert.ok(localImageCacheSize() <= LOCAL_IMAGE_CACHE_LIMIT + 1, `实际 ${localImageCacheSize()}`)
    assert.ok(revoked.length > 0, '淘汰的 blob: 必须 revoke')
  } finally {
    URL.revokeObjectURL = original
  }
})

test('增量渲染只在传了 loadLocalImage 时读本地图片', async () => {
  const calls = []
  const withLoader = document.createElement('div')
  renderIncrementalMarkdown(withLoader, '![x](/tmp/inc.png)', { loadLocalImage: async (p) => { calls.push(p); return png() } })
  await flush()
  assert.ok(withLoader.querySelector('img').src.startsWith('blob:'))
  assert.deepEqual(calls, ['/tmp/inc.png'])

  const plain = document.createElement('div')
  renderIncrementalMarkdown(plain, '![x](/tmp/inc.png)')
  assert.equal(plain.querySelector('img'), null)
})

test('api-client.getBlob:GET /api/file 带 cookie、path 编码、401 重试一次、404 → null', async () => {
  const requests = []
  let status = 401
  const client = createApiClient({
    baseUrl: 'http://127.0.0.1:3080',
    onUnauthorized: async () => { status = 200; return true },
    fetch: async (url, init) => {
      requests.push({ url, init })
      if (status !== 200) return new Response('', { status })
      return new Response(png(), { status: 200, headers: { 'content-type': 'image/png' } })
    }
  })
  const blob = await client.getBlob('/api/file', { path: '/tmp/my graph&.png' })
  assert.equal(blob.type, 'image/png')
  assert.equal(requests.length, 2)
  const url = new URL(requests[1].url)
  assert.equal(url.pathname, '/api/file')
  assert.equal(url.searchParams.get('path'), '/tmp/my graph&.png')
  assert.equal(requests[1].init.method, 'GET')
  assert.equal(requests[1].init.credentials, 'include')

  status = 404
  assert.equal(await client.getBlob('/api/file', { path: '/nope.png' }), null)
})
