/**
 * 插件卡的规格表与 Subagent 模型候选合并。
 *
 * 两处都值得单测,因为它们的错法都很安静:
 *   1. 卡片规格写错了命名空间 → 卡片在"此部署没有它"的规则下**不渲染**,
 *      页面上什么都不缺,看起来一切正常。
 *   2. 候选合并漏了"目录里已经不存在但仍然存着"的路由 → 用户看不到它,
 *      也就删不掉,而下次保存会把它原样写回去。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PLUGIN_CARDS, availableCards, credentialRef
} from '../src/app/sidepanel/settings/plugin-config-cards.js'
import {
  routeKey, splitRouteKey, subagentModelCandidates, groupSubagentCandidates,
  routesForSelection, subagentModelSelectionValid
} from '../src/features/settings/subagent-models.js'

test('每张卡都声明了命名空间与至少一个字段', () => {
  for (const card of PLUGIN_CARDS) {
    assert.ok(card.id, '缺少 id')
    assert.ok(card.namespace, card.id + ' 缺少命名空间')
    assert.ok(card.title && card.description, card.id + ' 缺少标题或描述')
    assert.ok(card.fields.length > 0, card.id + ' 没有字段')
    for (const field of card.fields) {
      assert.ok(field.id && field.label && field.hint, card.id + '/' + field.id + ' 字段不完整')
      assert.ok(['number', 'text'].includes(field.kind), card.id + '/' + field.id + ' kind 非法')
    }
  }
})

test('联网搜索卡带 baseURL + maxUses 与一条凭证', () => {
  const card = PLUGIN_CARDS.find((entry) => entry.id === 'web-search')
  assert.equal(card.namespace, 'web-search-deepseek')
  assert.deepEqual(card.fields.map((f) => f.id), ['baseURL', 'maxUses'])
  assert.equal(card.credential.field, 'apiKey')
  assert.equal(card.credential.refField, 'apiKeyEnv')
  assert.equal(card.credential.defaultRef, 'DEEPSEEK_API_KEY')
})

test('Subagent 卡声明两段:limits 在 subagent,模型选择在 subagent-model-selection', () => {
  const card = PLUGIN_CARDS.find((entry) => entry.id === 'subagent')
  assert.equal(card.namespace, 'subagent')
  assert.deepEqual(card.fields.map((f) => f.id), ['maxDepth', 'maxActiveSubagents'])
  assert.equal(card.modelSelection.namespace, 'subagent-model-selection')
  // 两个字段各有自己的非法文案 —— 共用一句"请输入数字"会丢掉"0 合法 / 1 起"的区别。
  assert.equal(card.fields[0].invalidKey, 'plug.subagentDepthInvalid')
  assert.equal(card.fields[1].invalidKey, 'plug.subagentCapacityInvalid')
})

test('availableCards:命名空间缺席的卡整体不渲染', () => {
  const namespaces = new Set(['shell', 'web-search-deepseek', 'subagent-model-selection'])
  const ids = availableCards(PLUGIN_CARDS, namespaces).map((card) => card.id)
  assert.deepEqual(ids, ['bash', 'web-search'])
  // subagent 缺了 subagent 命名空间 → 整卡不渲染(不能只画半张卡)。
  assert.ok(!ids.includes('subagent'))
})

test('availableCards:接受数组与 undefined', () => {
  assert.deepEqual(availableCards(PLUGIN_CARDS, ['shell']).map((c) => c.id), ['bash'])
  assert.deepEqual(availableCards(PLUGIN_CARDS, undefined), [])
})

test('credentialRef:命名空间里的 apiKeyEnv 是权威,缺失才用默认 ref', () => {
  const card = PLUGIN_CARDS.find((entry) => entry.id === 'web-search')
  assert.equal(credentialRef(card, { apiKeyEnv: 'MY_KEY' }), 'MY_KEY')
  assert.equal(credentialRef(card, { apiKeyEnv: '  ' }), 'DEEPSEEK_API_KEY')
  assert.equal(credentialRef(card, {}), 'DEEPSEEK_API_KEY')
  assert.equal(credentialRef(card, null), 'DEEPSEEK_API_KEY')
  // 没有凭证的卡返回 null(调用方据此不画那一行)。
  assert.equal(credentialRef(PLUGIN_CARDS[0], {}), null)
})

// ---- Subagent 模型候选 ----

const CATALOG = [
  { id: 'alpha', name: 'Alpha', models: [{ id: 'a-1', name: 'A One' }, { id: 'a-2', name: '' }] },
  { id: 'beta', name: 'Beta', models: [{ id: 'b-1', name: 'B One' }] }
]

test('目录里的模型全部列出,已选状态按已存路由标记', () => {
  const rows = subagentModelCandidates(CATALOG, [{ provider: 'beta', model: 'b-1' }])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.key), ['alpha::a-1', 'alpha::a-2', 'beta::b-1'])
  assert.deepEqual(rows.map((r) => r.selected), [false, false, true])
  assert.ok(rows.every((r) => r.available))
})

test('模型没有 name 时回落到 id', () => {
  const rows = subagentModelCandidates(CATALOG, [])
  assert.equal(rows.find((r) => r.key === 'alpha::a-2').modelName, 'a-2')
})

test('目录里已经消失但仍存着的路由仍然列出,标成不可用且保持勾选', () => {
  const rows = subagentModelCandidates(CATALOG, [
    { provider: 'beta', model: 'b-1' },
    { provider: 'ghost', model: 'g-1' }
  ])
  const ghost = rows.find((r) => r.key === 'ghost::g-1')
  assert.ok(ghost, '消失的路由必须还在候选表里,否则用户删不掉它')
  assert.equal(ghost.available, false)
  assert.equal(ghost.selected, true)
})

test('忽略不完整的路由项(缺 provider 或 model)', () => {
  const rows = subagentModelCandidates(CATALOG, [
    { provider: 'alpha' }, { model: 'x' }, null, { provider: 'alpha', model: 'a-1' }
  ])
  assert.equal(rows.filter((r) => r.selected).length, 1)
})

test('分组:按目录顺序成组,不可用的一组排最后', () => {
  const rows = subagentModelCandidates(CATALOG, [{ provider: 'ghost', model: 'g-1' }])
  const groups = groupSubagentCandidates(rows, 'unavailable')
  assert.deepEqual(groups.map((g) => g.provider), ['alpha', 'beta', '__unavailable__'])
  assert.equal(groups[2].providerName, 'unavailable')
  assert.equal(groups[0].candidates.length, 2)
})

test('routesForSelection:按显示顺序输出,且不残留取消勾选的路由', () => {
  const rows = subagentModelCandidates(CATALOG, [])
  const selection = new Set(['beta::b-1', 'alpha::a-1'])
  assert.deepEqual(routesForSelection(rows, selection), [
    { provider: 'alpha', model: 'a-1' },
    { provider: 'beta', model: 'b-1' }
  ])
})

test('保存条件:关闭时可以空,开启时必须至少一个', () => {
  assert.equal(subagentModelSelectionValid(false, new Set()), true)
  assert.equal(subagentModelSelectionValid(true, new Set()), false)
  assert.equal(subagentModelSelectionValid(true, new Set(['a'])), true)
})

test('routeKey/splitRouteKey 互逆,model 里带点号也不歧义', () => {
  const key = routeKey('prov', 'gpt-4.1')
  assert.equal(key, 'prov::gpt-4.1')
  assert.deepEqual(splitRouteKey(key), { provider: 'prov', model: 'gpt-4.1' })
  assert.equal(splitRouteKey('nope'), null)
})
