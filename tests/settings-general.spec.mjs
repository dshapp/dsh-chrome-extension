/**
 * 主题偏好的本地镜像(设置页外观三块色板 / 侧栏启动时的恢复)。
 *
 * 这条规则错起来很隐蔽:把"跟随系统"实现成"把当前系统值写死",界面看起来
 * 完全正常,只有用户在系统切深浅色之后才会发现它不再跟随 —— 而那时没人会
 * 想到是设置页写的。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveTheme, normalizeThemePreference, applyTheme } from '../src/app/sidepanel/theme.js'

function fakeRoot() {
  const attrs = new Map()
  return {
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value),
    attrs
  }
}

const media = (matches) => ({ matches })

test('resolveTheme:读媒体查询的 matches,media 缺席按浅色', () => {
  assert.equal(resolveTheme(media(false)), 'light')
  assert.equal(resolveTheme(media(true)), 'dark')
  assert.equal(resolveTheme(null), 'light')
  assert.equal(resolveTheme(undefined), 'light')
})

test('normalizeThemePreference:只认三个合法值,其余回落到 system', () => {
  for (const value of ['system', 'light', 'dark']) {
    assert.equal(normalizeThemePreference(value), value)
  }
  for (const value of ['', 'Dark', 'auto', null, undefined, 42, {}]) {
    assert.equal(normalizeThemePreference(value), 'system', String(value) + ' 应回落到 system')
  }
})

test('applyTheme:写 data-theme 与 data-theme-preference 两个属性', () => {
  const root = fakeRoot()
  applyTheme(root, 'dark', media(false))
  // 显式 dark 时媒体查询是暗的也不该改判 —— preference 就是要覆盖系统。
  assert.equal(root.getAttribute('data-theme'), 'dark')
  assert.equal(root.getAttribute('data-theme-preference'), 'dark')
})

test('applyTheme:system 跟随媒体查询,且两个属性分开记录', () => {
  const root = fakeRoot()
  applyTheme(root, 'system', media(true))
  assert.equal(root.getAttribute('data-theme'), 'dark')
  assert.equal(root.getAttribute('data-theme-preference'), 'system')

  const root2 = fakeRoot()
  applyTheme(root2, 'system', media(false))
  assert.equal(root2.getAttribute('data-theme'), 'light')
  assert.equal(root2.getAttribute('data-theme-preference'), 'system')
})

test('applyTheme:非法偏好按 system 处理而不是抛错', () => {
  const root = fakeRoot()
  applyTheme(root, 'nonsense', media(true))
  assert.equal(root.getAttribute('data-theme'), 'dark')
  assert.equal(root.getAttribute('data-theme-preference'), 'system')
})
