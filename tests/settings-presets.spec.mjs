/**
 * 预设页的标识符规则(对齐 Mac PresetsSection 的 copy sheet)。
 *
 * 这条规则值得单测,因为它决定的是"能不能按下创建":放松一位就会让宿主的
 * agentPresets/copy 回 agent-preset/exists,而那个失败发生在用户已经填完表单之后。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PRESET_ID_PATTERN, isPresetIdValid, isPresetIdOccupied,
  canConfirmPresetCopy, presetCopyProblem
} from '../src/features/settings/preset-identifier.js'

test('标识符接受小写字母开头的 kebab 形式', () => {
  for (const id of ['a', 'ab', 'my-agent', 'a1-b2-c3', 'x-1']) {
    assert.equal(isPresetIdValid(id), true, id + ' 应合法')
  }
})

test('标识符拒绝大写、下划线、连续/首尾连字符与空串', () => {
  for (const id of ['', 'A', 'my_agent', '-a', 'a-', 'a--b', 'a b', '1a', 'a.b']) {
    assert.equal(isPresetIdValid(id), false, id + ' 应非法')
  }
})

test('标识符占用判定只认同名(与大小写无关的规范化不在这一层)', () => {
  const presets = [{ id: 'standard' }, { id: 'ptc' }]
  assert.equal(isPresetIdOccupied('ptc', presets), true)
  assert.equal(isPresetIdOccupied('ptc2', presets), false)
  assert.equal(isPresetIdOccupied('', presets), false)
})

test('canConfirmPresetCopy:合法 + 未占用 + 不在提交中才放行', () => {
  const presets = [{ id: 'standard' }]
  assert.equal(canConfirmPresetCopy({ id: 'mine', presets, copying: false }), true)
  assert.equal(canConfirmPresetCopy({ id: 'mine', presets, copying: true }), false)
  assert.equal(canConfirmPresetCopy({ id: 'standard', presets, copying: false }), false)
  assert.equal(canConfirmPresetCopy({ id: 'Mine', presets, copying: false }), false)
  assert.equal(canConfirmPresetCopy({ id: '  ', presets, copying: false }), false)
  assert.equal(presetCopyProblem({ id: 'mine', presets, copying: false }), null)
  assert.equal(presetCopyProblem({ id: 'mine', presets, copying: true }), 'busy')
  assert.equal(presetCopyProblem({ id: 'standard', presets, copying: false }), 'occupied')
  assert.equal(presetCopyProblem({ id: 'Mine', presets, copying: false }), 'invalid')
})

test('非法优先于占用:先报格式,再报重名', () => {
  const presets = [{ id: 'Standard' }]
  // 'Standard' 本身非法(大写)。即使表里存在同名项,报的也应是 invalid ——
  // 提示"已被占用"会把用户引向换名字,而问题在字符本身。
  assert.equal(presetCopyProblem({ id: 'Standard', presets, copying: false }), 'invalid')
})

test('模式常量与宿主契约一致', () => {
  assert.equal(PRESET_ID_PATTERN.source, '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$')
})
