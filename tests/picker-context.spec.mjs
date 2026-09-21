/**
 * 圈选元素注入 prompt 的 XML 格式。
 *
 * 这个块每条带元素的消息都会整段重发,所以体积就是 token 成本。旧格式把
 * name 放正文、text/note 放子节点、每行还带 4 空格缩进,20 个元素要 8044 字节;
 * 新格式全部收进属性、一行一元素、不缩进,同一批 fixture 只要 ~5500 字节。
 *
 * 同时不再发 xpath / ref:bridge 的 elementExpression() 只认 @eN 与 @option:<id>,
 * 其余一律走 querySelector,XPath 无人消费;picker 的 ref_N 也不在任何工具的可解析
 * 范围内。发出去只会让模型拿它去 click,然后报 no element matches。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatPickedElementsContext } from '../src/features/element-picker/element-picker-context.js'

/** 一个典型的深 DOM 链接元素,带全量字段(含不该进 prompt 的 xpath/ref)。 */
function element(overrides = {}) {
  return {
    ref: 'ref_101',
    selector: 'body > div#app > main > section:nth-of-type(3) > ul > li:nth-of-type(1) > a',
    xpath: '/html/body/div[1]/main/section[3]/ul/li[1]/a',
    tag: 'a',
    role: '',
    name: '查看详情',
    text: '查看详情',
    attrs: { id: '', class: 'card-title', ariaLabel: '', placeholder: '', href: '/p/1?a=1&b=2' },
    rect: { x: 0, y: 0, width: 0, height: 0 },
    url: 'https://example.com/search?q=abc',
    title: '搜索结果',
    ...overrides,
  }
}

const lines = (xml) => xml.split('\n')

test('空输入回空串,调用方据此决定不拼接', () => {
  assert.equal(formatPickedElementsContext([]), '')
  assert.equal(formatPickedElementsContext(null), '')
  assert.equal(formatPickedElementsContext(undefined), '')
  assert.equal(formatPickedElementsContext({}), '')
})

test('一行一元素,全部字段落在属性里,没有子节点', () => {
  const xml = formatPickedElementsContext([element({ note: '改成新窗口打开' })])
  const rows = lines(xml)
  assert.equal(rows.length, 3, '应当是 根标签 + 1 元素 + 结束标签:\n' + xml)
  assert.match(rows[0], /^<selected_page_elements[ >]/)
  assert.match(rows[1], /^<element i="1" .* \/>$/, rows[1])
  assert.equal(rows[2], '</selected_page_elements>')
  assert.ok(!xml.includes('<note>'), '批注不该再走子节点:' + xml)
  assert.ok(!xml.includes('<text>'), '可见文本不该再走子节点:' + xml)
  assert.match(rows[1], / note="改成新窗口打开"/)
})

test('xpath 与 ref 不进 prompt', () => {
  const xml = formatPickedElementsContext([element()])
  assert.ok(!xml.includes('xpath='), xml)
  // 注意别被 href="…" 里的 "ref=" 误伤,只检查独立的 ref 属性
  assert.ok(!/\sref="/.test(xml), xml)
  assert.ok(!xml.includes('count='), '一行一元素后 count 是冗余:' + xml)
})

test('属性值只转义 & < ",> 与 \' 保留原样', () => {
  const xml = formatPickedElementsContext([element({
    name: 'A & B <C> "D" \'E\'',
    attrs: { href: '/x?a=1&b=2' },
    note: '',
  })])
  assert.match(xml, /name="A &amp; B &lt;C> &quot;D&quot; 'E'"/, xml)
  assert.ok(xml.includes('href="/x?a=1&amp;b=2"'), xml)
  // css 里的每个 ">" 省下 3 字节
  assert.ok(xml.includes(' > '), 'css 里的 ">" 应保持原样:' + xml)
  assert.ok(!xml.includes('&gt;'), xml)
})

test('批注里的换行折叠为单空格,不劈开属性行', () => {
  const xml = formatPickedElementsContext([element({ note: '第一行需求\n第二行需求' })])
  const rows = lines(xml)
  assert.equal(rows.length, 3, '多行批注不该增加行数:\n' + xml)
  assert.match(rows[1], / note="第一行需求 第二行需求"/)
})

test('重复字段被抑制:role==tag、text==name、aria_label/placeholder==name', () => {
  const xml = formatPickedElementsContext([element({
    tag: 'button',
    role: 'button',
    name: '提交',
    text: '提交',
    attrs: { ariaLabel: '提交', placeholder: '', href: '' },
  })])
  const row = lines(xml)[1]
  assert.ok(!row.includes(' role='), row)
  assert.ok(!row.includes(' text='), row)
  assert.ok(!row.includes(' aria_label='), row)
  assert.ok(!row.includes(' href='), '空 href 不该产出属性:' + row)
  assert.match(row, / name="提交"/)
})

test('role/aria_label/placeholder 与 name 不同时才出', () => {
  const xml = formatPickedElementsContext([element({
    tag: 'div',
    role: 'button',
    name: '提交',
    attrs: { ariaLabel: '提交订单', placeholder: '请输入', href: '' },
  })])
  const row = lines(xml)[1]
  assert.match(row, / role="button"/)
  assert.match(row, / aria_label="提交订单"/)
  assert.match(row, / placeholder="请输入"/)
})

test('name 与 text 都为空时该行仍是合法自闭合标签', () => {
  const xml = formatPickedElementsContext([element({ name: '', text: '', note: '' })])
  assert.match(lines(xml)[1], /^<element i="1" .* \/>$/)
})

test('截断:name/title 限 160,note 限 500,超限补省略号', () => {
  const longName = 'x'.repeat(200)
  const longNote = 'y'.repeat(600)
  const xml = formatPickedElementsContext([element({ name: longName, text: '', note: longNote })])
  const row = lines(xml)[1]
  assert.match(row, new RegExp(' name="x{160}…"'))
  assert.match(row, new RegExp(' note="y{500}…"'))
  assert.ok(!row.includes('x'.repeat(161)), 'name 超长没截')
  const shortNote = 'z'.repeat(500)
  const xml2 = formatPickedElementsContext([element({ name: 'n', text: '', note: shortNote })])
  assert.ok(!lines(xml2)[1].includes('…'), '500 字以内不该补省略号')
})

test('根标签的 url 不截断、title 截断,取第一个带 url 的元素', () => {
  const longTitle = 't'.repeat(200)
  const xml = formatPickedElementsContext([
    element({ url: '', title: '' }),
    element({ url: 'https://example.com/' + 'p'.repeat(200), title: longTitle }),
  ])
  const root = lines(xml)[0]
  assert.match(root, new RegExp('url="https://example\\.com/p{200}"'), root)
  assert.match(root, new RegExp(' title="t{160}…"'))
  assert.equal(lines(xml).length, 4, xml)
})

test('没有 url/title 时根标签不带属性', () => {
  const xml = formatPickedElementsContext([element({ url: '', title: '' })])
  assert.equal(lines(xml)[0], '<selected_page_elements>')
})

test('20 元素体积回归门禁(< 6000 字节)', () => {
  const elements = Array.from({ length: 20 }, (_, i) => element({
    selector: 'body > div#app > div:nth-of-type(2) > main > section:nth-of-type(3) > ul > li:nth-of-type(' + (i + 1) + ') > a',
    xpath: '/html/body/div[1]/div[2]/main/section[3]/ul/li[' + (i + 1) + ']/a',
    ref: 'ref_' + (101 + i),
    name: '查看详情 - 商品关键字条目' + (i + 1),
    text: '查看详情 - 商品关键字条目 ' + (i + 1) + ' 副标题',
    attrs: { href: 'https://example.com/products/' + (i + 1) + '?utm_source=feed&utm_campaign=spring' },
    note: i % 4 === 0 ? '把这个链接改成新窗口打开,并补上 rel=noopener' : '',
  }))
  const xml = formatPickedElementsContext(elements)
  // 旧格式同一批 fixture 是 8044 字节;新格式实测 ~5513。
  assert.ok(xml.length < 6000, '20 元素输出涨到 ' + xml.length + ' 字节,格式回归了')
  assert.equal(lines(xml).length, 22, '应当 1 + 20 + 1 = 22 行')
  assert.match(xml, /^<selected_page_elements /)
  assert.equal(xml.endsWith('</selected_page_elements>'), true)
})
