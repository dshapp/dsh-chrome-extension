/**
 * DSH 0.1.7 协议适配:job/list 流、role:"tool" 结果消息、compact-checkpoint、
 * 子代理目录(session/projections)、归档 session-active 重试、宿主置顶、
 * 设置命名空间改名与预设 isBuiltIn 判定。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { createSessionStore } from '../src/features/sessions/session-store.js'
import { createPinnedStore } from '../src/features/sessions/pinned-store.js'
import { RPC, STREAM } from '../src/platform/dsh/rpc-methods.js'
import { PLUGIN_CARDS, availableCards } from '../src/app/sidepanel/settings/plugin-config-cards.js'
import { presetRegistryNamespace } from '../src/app/sidepanel/settings/general-pane.js'
import { isBuiltInPreset, presetDisplayName, presetMenuLabel } from '../src/app/sidepanel/composer-dock.js'
import { setLang } from '../src/shared/i18n.js'

const frame = (streamId, value) => ({ type: 'item', streamId, value })

function harness(respond = () => ({})) {
  const calls = []
  const subscriptions = []
  const unsubscribed = []
  const connection = {
    subscribe(streamId, endpoint, args) { subscriptions.push({ streamId, endpoint, args }) },
    unsubscribe(streamId) { unsubscribed.push(streamId) },
    async call(method, args) {
      calls.push({ method, args })
      return respond(method, args)
    }
  }
  const service = createSessionService(connection)
  return { service, calls, subscriptions, unsubscribed }
}

test('job/list:打开会话即订阅,rows 帧整组替换任务;切会话换流并丢弃旧流迟到帧', async () => {
  const { service, subscriptions, unsubscribed } = harness()
  await service.open('s1')
  const sub = subscriptions.find((s) => s.endpoint === STREAM.jobs)
  assert.deepEqual(sub, { streamId: 'jobs:s1', endpoint: 'job/list', args: { request: { sessionId: 's1' } } })
  const job = { id: 'j1', kind: 'bash', label: 'sleep', status: 'running', startedAt: 1 }
  service.handleMuxFrame(frame('jobs:s1', { type: 'rows', jobs: [job] }))
  assert.deepEqual(service.getRuntimeSnapshot().jobs, [job])

  await service.open('s2')
  assert.ok(unsubscribed.includes('jobs:s1'))
  service.handleMuxFrame(frame('jobs:s1', { type: 'rows', jobs: [job, job] }))
  assert.deepEqual(service.getRuntimeSnapshot().jobs, [])
})

test('tool/result v4:role:"tool" 消息按 toolCallId 配对,isError 来自消息', () => {
  const store = createSessionStore('s1')
  store.applyEvent({ seq: 1, type: 'turn/start', data: {} })
  store.applyEvent({ seq: 2, type: 'tool/call', data: { callId: 'c1', name: 'bash', input: { command: 'ls' } } })
  store.applyEvent({
    seq: 3, type: 'tool/result', data: {
      message: {
        role: 'tool', id: 'm3', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
        content: [{ type: 'text', text: 'boom' }], isError: true
      }
    }
  })
  const tool = store.toolCall('c1')
  assert.ok(tool, 'tool node exists')
  assert.ok(tool.result, 'result paired')
  assert.equal(tool.result.isError, true)
  assert.deepEqual(tool.result.content.map((b) => b.text), ['boom'])
})

test('子代理目录:session/projections 的 subagentCatalog 映射成旧 entries 形状', async () => {
  const { service, calls } = harness((method) => {
    if (method === RPC.sessionProjections) {
      return { asOfSeq: 5, values: { subagentCatalog: [
        { id: 'c1', mode: 'continuable', label: 'worker', createdAt: 1 },
        { id: 'c2', mode: 'unknown', createdAt: 2 }
      ] } }
    }
    return {}
  })
  service.listStore.upsertAndNotify({ sessionId: 'c1', updatedAt: 1, running: true, origin: 'subagent', parentSessionId: 'p' })
  service.listStore.upsertAndNotify({ sessionId: 'g1', updatedAt: 1, running: false, origin: 'subagent', parentSessionId: 'c1' })
  const value = await service.listSubagents('p')
  assert.deepEqual(calls.at(-1), { method: 'session/projections', args: { request: { sessionId: 'p' } } })
  assert.deepEqual(value.entries, [
    { kind: 'child', id: 'c1', mode: 'continuable', label: 'worker', activity: 'running', hasChildren: true },
    { kind: 'child', id: 'c2', mode: 'unknown', label: undefined, activity: 'not-running', hasChildren: false }
  ])
})

test('归档:session-active 经确认后带 stopActivity 重试;拒绝则返回 null', async () => {
  const attempts = []
  const { service } = harness((method, args) => {
    if (method !== RPC.workspaceArchiveSession) return {}
    attempts.push(args.request)
    if (!args.request.stopActivity) {
      const error = new Error('active'); error.code = 'workspace/session-active'
      error.details = { sessionId: 's1', activity: ['turn'] }
      throw error
    }
    return { archivedSessionIds: ['s1'] }
  })
  assert.equal(await service.archive('s1', { confirmStop: async () => false }), null)
  assert.deepEqual(attempts, [{ sessionId: 's1' }])
  attempts.length = 0
  assert.notEqual(await service.archive('s1', { confirmStop: async () => true }), null)
  assert.deepEqual(attempts, [{ sessionId: 's1' }, { sessionId: 's1', stopActivity: true }])
  await assert.rejects(service.archive('s1'), /active/)
})

test('置顶:宿主集合到达后切宿主模式,写走 pin/unpin RPC,失败回滚', async () => {
  const calls = []
  let fail = false
  const connection = {
    async call(method, args) {
      calls.push(method)
      if (fail) throw new Error('nope')
      return { pinnedSessionIds: method === RPC.workspacePinSession ? [args.request.sessionId, 'a'] : [] }
    }
  }
  let errors = 0
  const store = createPinnedStore({ connection, rpc: RPC, onError: () => { errors++ } })
  store.applyHost(['a'])
  assert.equal(store.hostBacked, true)
  assert.deepEqual(store.order, ['a'])
  store.setPinned('b', true)
  assert.deepEqual(store.order, ['b', 'a'], '乐观:最近置顶在前')
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(calls.includes('workspace/pinSession'))
  assert.equal(store.reorder('a', 'b'), false, '宿主模式不支持重排')
  fail = true
  store.setPinned('a', false)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(store.order, ['b', 'a'], '失败回滚')
  assert.equal(errors, 1)
})

test('设置命名空间:新名优先,老宿主回落旧名', () => {
  const cards017 = availableCards(PLUGIN_CARDS, ['bash-sandbox', 'subagent', 'subagent-model-selection-settings'])
  assert.equal(cards017.find((c) => c.id === 'bash').namespace, 'bash-sandbox')
  const cards016 = availableCards(PLUGIN_CARDS, ['shell'])
  assert.equal(cards016.find((c) => c.id === 'bash').namespace, 'shell')
  assert.deepEqual(presetRegistryNamespace(new Set(['agent-preset-registry'])),
    { name: 'agent-preset-registry', defaultField: 'selectedDefault' })
  assert.deepEqual(presetRegistryNamespace(new Set(['agent-presets'])),
    { name: 'agent-presets', defaultField: 'default' })
  assert.equal(presetRegistryNamespace(new Set()), null)
})

test('预设:isBuiltIn = 出厂 id 且无自带 name;ptc 本地化,自定义加标记', () => {
  setLang('zh')
  assert.equal(isBuiltInPreset({ id: 'ptc' }), true)
  assert.equal(isBuiltInPreset({ id: 'ptc', name: 'My PTC' }), false)
  assert.equal(isBuiltInPreset({ id: 'mine', name: 'Mine' }), false)
  assert.equal(presetDisplayName({ id: 'ptc' }), 'PTC 模式')
  assert.equal(presetMenuLabel({ id: 'mine', name: 'Mine' }), 'Mine · 自定义')
  assert.equal(presetMenuLabel({ id: 'standard' }), '标准模式')
  // 0.1.6 roster 仍按 trust 判定。
  assert.equal(isBuiltInPreset({ id: 'code', name: 'code', trust: 'system' }), true)
})
