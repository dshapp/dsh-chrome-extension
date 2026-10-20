/**
 * 输入框上方的运行状态条(对齐 Mac RunningStatusRow / liveActivity):
 * 文案是工作类别 + 用时,不是运行中工具的摘要;不在运行时隐藏。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="running-status" hidden></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const { setLang } = await import('../src/shared/i18n.js')
const { liveActivityKey, liveToolName, runningStatusLabel, mountRunningStatus } = await import('../src/features/chat/running-status.js')

const tool = (name, turn, result = null) => ({ kind: 'toolCall', name, turn, result })

test('工具名按 Mac liveActivity 归类', () => {
  assert.equal(liveActivityKey('bash'), 'activity.commands')
  assert.equal(liveActivityKey('run_code'), 'activity.code')
  assert.equal(liveActivityKey('grep'), 'activity.search')
  assert.equal(liveActivityKey('cordis_runtime_inspect'), 'activity.search')
  assert.equal(liveActivityKey('terminal_write'), 'activity.commands')
  assert.equal(liveActivityKey('subagent_fork'), 'activity.subagents')
  assert.equal(liveActivityKey('mcp__chrome__click'), 'activity.tools')
})

test('live 工具只看最新一轮里尚无结果的调用', () => {
  const nodes = [tool('bash', 1), { kind: 'user', turn: 2 }, tool('read', 2, { ok: true })]
  assert.equal(liveToolName({ running: true, nodes }), null)
  assert.equal(liveToolName({ running: true, nodes: [...nodes, tool('web_fetch', 2)] }), 'web_fetch')
  assert.equal(liveToolName({ running: false, nodes: [...nodes, tool('web_fetch', 2)] }), null)
})

test('文案:中英文与 Mac 一致,空闲时为 null', () => {
  setLang('zh')
  assert.equal(runningStatusLabel({ running: false, nodes: [] }), null)
  assert.equal(runningStatusLabel({ running: false, nodes: [] }, { awaitingTurnStart: true }), '正在分析请求')
  assert.equal(runningStatusLabel({ running: true, nodes: [{ kind: 'user', turn: 1 }] }), '正在分析请求')
  assert.equal(runningStatusLabel({ running: true, nodes: [tool('bash', 1)] }), '正在运行命令')
  setLang('en')
  assert.equal(runningStatusLabel({ running: true, nodes: [tool('run_code', 1)] }), 'Running code')
  setLang('zh')
})

test('状态条:用时取本轮起点,下限 1 秒;没有起点不显示用时;清除即隐藏', () => {
  setLang('zh')
  const el = document.getElementById('running-status')
  const bar = mountRunningStatus(el)
  bar.set('正在运行命令', Date.now() - 65_000)
  assert.equal(el.hidden, false)
  assert.equal(el.querySelector('.running-status-label').textContent, '正在运行命令')
  assert.equal(el.querySelector('.running-status-time').textContent, '· 1分5秒')
  bar.set('正在分析请求', Date.now())
  assert.equal(el.querySelector('.running-status-time').textContent, '· 1秒')
  bar.set('正在分析请求')
  assert.equal(el.querySelector('.running-status-time').textContent, '')
  bar.clear()
  assert.equal(el.hidden, true)
})
