/**
 * renderSkillsMenu 必须真的渲染出技能行。
 *
 * 旧实现把箭头函数体写成了逗号表达式:
 *   (\`<div …>\`, \`<code>…</code>\`, \`<span>…</span>\`, "</div>")
 * 逗号运算符只返回最后一个值,所以每个技能渲染出来的只是一个孤立的 </div>,
 * 技能名/描述全部丢失,连续多项还会吐出一串没有开标签的 </div>。函数是导出的,
 * 一旦被接上就是坏菜单 —— 断言要看真实输出,不能只看"返回了非空字符串"。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderSkillsMenu } from '../src/features/skills/skill-service.js'

test('每个技能都渲染成一个完整的行(开标签 + 名字 + 描述 + 闭标签)', () => {
  const html = renderSkillsMenu([
    { name: 'alpha', description: 'first' },
    { name: 'beta', description: 'second' }
  ])
  assert.match(html, /<div class="skill-row" data-skill-name="alpha">/)
  assert.match(html, /<code>\/alpha<\/code>/)
  assert.match(html, /<span class="skill-desc">first<\/span>/)
  assert.match(html, /<div class="skill-row" data-skill-name="beta">/)
  assert.match(html, /<code>\/beta<\/code>/)
  assert.match(html, /<span class="skill-desc">second<\/span>/)
})

test('开/闭 div 数量相等,不出现孤立的 </div>', () => {
  const html = renderSkillsMenu([{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }, { name: 'c' }])
  const open = (html.match(/<div class="skill-row"/g) || []).length
  const close = (html.match(/<\/div>/g) || []).length
  assert.equal(open, 3, '三个技能应有三个开标签')
  assert.equal(close, 3, '闭标签数量必须与开标签一致')
  assert.ok(!html.startsWith('</div>'), '输出不能以孤立闭标签开头')
})

test('缺 description 时渲染空 span,不是 undefined', () => {
  const html = renderSkillsMenu([{ name: 'no-desc' }])
  assert.match(html, /<span class="skill-desc"><\/span>/)
  assert.ok(!html.includes('undefined'))
})

test('空列表返回空字符串', () => {
  assert.equal(renderSkillsMenu([]), '')
})

test('技能名与描述做 HTML 转义(不被注入)', () => {
  const html = renderSkillsMenu([{ name: '<img src=x onerror=alert(1)>', description: '" onmouseover="x' }])
  assert.ok(!html.includes('<img'), '技能名里的标签必须被转义')
  assert.ok(html.includes('&lt;img'), '应当出现转义后的 &lt;img')
  assert.ok(!/" onmouseover="/.test(html), '描述里的引号必须被转义')
})
