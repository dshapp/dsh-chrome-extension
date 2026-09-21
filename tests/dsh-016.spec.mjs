/**
 * DSH 0.1.6 协议适配的四个面:inbox 投影驱动的待发队列、权限目录
 * (permissionPresets/catalog)、以及两条新转发事件。
 *
 * 这些用例直接驱动 session-service 的公开入口(open + handleMuxFrame),用假
 * connection 喂真实形状的帧,断言 0.1.5 与 0.1.6 两条路都得到同一份队列。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { createSessionStore } from '../src/features/sessions/session-store.js'
import { RPC, HOST, STREAM } from '../src/platform/dsh/rpc-methods.js'

/// 一条待发消息,形状对齐宿主 inbox 投影里的 UserMessage。
function message(id, { kind = 'user', rpcId, text = id } = {}) {
  return {
    id, role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, ...(rpcId === undefined ? {} : { rpcId }) }
  }
}

function harness({ catalog } = {}) {
  const calls = []
  const subscriptions = []
  const connection = {
    subscribe(streamId, endpoint, args) { subscriptions.push({ streamId, endpoint, args }) },
    unsubscribe() {},
    async call(method, args) {
      calls.push({ method, args })
      if (method === RPC.permissionPresetsCatalog) {
        if (catalog === undefined) {
          const error = new Error('endpoint-unknown')
          error.code = 'endpoint-unknown'
          throw error
        }
        return catalog
      }
      return {}
    }
  }
  const service = createSessionService(connection)
  return { service, calls, subscriptions }
}

const frame = (streamId, value) => ({ type: 'item', streamId, value })

test('0.1.6: inbox 投影驱动待发队列,placement 由列表归属推导', () => {
  const { service } = harness()
  service.open('s1')
  service.handleMuxFrame(frame('control', {
    type: 'baseline',
    value: {
      jobs: {},
      projections: {
        s1: {
          asOfSeq: 5,
          values: {
            inbox: {
              'next-turn': [message('queued-1')],
              'next-step': [message('steer-1'), message('ctx-1', { kind: 'plugin' })]
            }
          }
        }
      }
    }
  }))
  const queue = service.getRuntimeSnapshot().queue
  assert.deepEqual(queue.map((item) => [item.id, item.placement]), [
    ['queued-1', 'queued'],
    ['steer-1', 'steering'],
    ['ctx-1', 'context']
  ])
  // 队列面板只渲染 queued;内容必须留在 message.content 上。
  assert.equal(queue[0].message.content[0].text, 'queued-1')
})

test('0.1.6: live inbox 投影帧替换队列', () => {
  const { service } = harness()
  service.open('s1')
  service.handleMuxFrame(frame('control', {
    type: 'projection', sessionId: 's1', key: 'inbox', seq: 6,
    value: { 'next-turn': [message('a'), message('b')], 'next-step': [] }
  }))
  assert.deepEqual(service.getRuntimeSnapshot().queue.map((item) => item.id), ['a', 'b'])
  service.handleMuxFrame(frame('control', {
    type: 'projection', sessionId: 's1', key: 'inbox', seq: 7,
    value: { 'next-turn': [message('b')], 'next-step': [] }
  }))
  assert.deepEqual(service.getRuntimeSnapshot().queue.map((item) => item.id), ['b'])
})

test('0.1.6: follow 快照里的 inbox 投影不会随后被空的控制缓存清掉', () => {
  const { service } = harness()
  service.open('s1')
  // 基线还没到就打开了会话:队列只能来自 follow 快照自身的 projections。
  service.handleMuxFrame(frame('follow:s1', {
    type: 'snapshot', cursor: 9,
    records: [],
    projections: { values: { inbox: { 'next-turn': [message('from-history')], 'next-step': [] } } }
  }))
  assert.deepEqual(service.getRuntimeSnapshot().queue.map((item) => item.id), ['from-history'])
  // 基线随后到达(0.1.6 的基线没有 queues 块)也不能把它清空。
  service.handleMuxFrame(frame('control', { type: 'baseline', value: { jobs: {}, projections: {} } }))
  assert.deepEqual(service.getRuntimeSnapshot().queue.map((item) => item.id), ['from-history'])
})

test('0.1.5 兼容:基线 queues 块与 live queue 帧仍然生效', () => {
  const { service } = harness()
  service.open('s1')
  service.handleMuxFrame(frame('control', {
    type: 'baseline',
    value: {
      queues: { s1: [{ id: 'q', placement: 'queued', message: { id: 'q', content: [] } }] },
      jobs: {},
      projections: {}
    }
  }))
  assert.deepEqual(service.getRuntimeSnapshot().queue.map((item) => item.id), ['q'])
  service.handleMuxFrame(frame('control', {
    type: 'queue', sessionId: 's1',
    items: [{ id: 'q2', placement: 'queued', message: { id: 'q2', content: [] } }]
  }))
  assert.deepEqual(service.getRuntimeSnapshot().queue.map((item) => item.id), ['q2'])
})

test('0.1.6: permissions 投影只剩 currentValue,选项由 permissionPresets/catalog 补齐', async () => {
  const { service, calls } = harness({
    catalog: { options: [{ value: 'read-only', name: 'Read only' }, { value: 'custom', name: 'custom' }] }
  })
  service.open('s1')
  service.handleMuxFrame(frame('control', {
    type: 'baseline',
    value: { jobs: {}, projections: { s1: { asOfSeq: 3, values: { permissions: { currentValue: 'read-only' } } } } }
  }))
  service.generationOpened()
  await Promise.resolve()
  const selection = service.getRuntimeSnapshot().permissions
  assert.equal(selection.currentValue, 'read-only')
  assert.deepEqual(selection.options.map((option) => option.value), ['read-only', 'custom'])
  assert.ok(calls.some((call) => call.method === RPC.permissionPresetsCatalog))
})

test('0.1.5 兼容:没有 catalog 命名空间时沿用投影自带的 options', async () => {
  const { service } = harness({ catalog: undefined })
  service.open('s1')
  service.handleMuxFrame(frame('control', {
    type: 'baseline',
    value: {
      jobs: {},
      projections: {
        s1: { asOfSeq: 3, values: { permissions: { currentValue: 'full', options: [{ value: 'full', name: 'Full' }] } } }
      }
    }
  }))
  service.generationOpened()
  await Promise.resolve()
  const selection = service.getRuntimeSnapshot().permissions
  assert.equal(selection.currentValue, 'full')
  assert.deepEqual(selection.options.map((option) => option.value), ['full'])
})

test('0.1.6: permission-presets/catalog-changed 触发重读目录', async () => {
  let catalog = { options: [{ value: 'a', name: 'A' }] }
  const calls = []
  const service = createSessionService({
    subscribe() {}, unsubscribe() {},
    async call(method) {
      calls.push(method)
      if (method === RPC.permissionPresetsCatalog) return catalog
      return {}
    }
  })
  service.open('s1')
  service.handleMuxFrame(frame('control', {
    type: 'baseline',
    value: { jobs: {}, projections: { s1: { asOfSeq: 1, values: { permissions: { currentValue: 'a' } } } } }
  }))
  service.generationOpened()
  await Promise.resolve()
  assert.deepEqual(service.getRuntimeSnapshot().permissions.options.map((o) => o.value), ['a'])
  catalog = { options: [{ value: 'b', name: 'B' }] }
  service.handleMuxFrame(frame('events', { type: 'emit', event: 'permission-presets/catalog-changed', args: [] }))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(service.getRuntimeSnapshot().permissions.options.map((o) => o.value), ['b'])
})

test('0.1.6: plugin-manager/changed 转成本地通知', () => {
  const { service } = harness()
  let seen = 0
  const off = service.onPluginManagerChanged(() => { seen += 1 })
  service.handleMuxFrame(frame('events', { type: 'emit', event: 'plugin-manager/changed', args: [{ stage: 'enable' }] }))
  assert.equal(seen, 1)
  // 未知/纯进度的转发事件不能把通知打出去。
  service.handleMuxFrame(frame('events', { type: 'emit', event: 'plugin-manager/install-log', args: [] }))
  assert.equal(seen, 1)
  off()
  service.handleMuxFrame(frame('events', { type: 'emit', event: 'plugin-manager/changed', args: [] }))
  assert.equal(seen, 1)
})

test('目录随进程而不是随会话:reset 之后合并结果仍然可用', () => {
  const store = createSessionStore()
  store.applyProjection('permissions', { currentValue: 'read-only' }, 1)
  store.setPermissionCatalog({ options: [{ value: 'read-only', name: 'Read only' }] })
  assert.deepEqual(store.getSnapshot().permissions.options.map((o) => o.value), ['read-only'])
  store.reset('s2')
  store.applyProjection('permissions', { currentValue: 'read-only' }, 1)
  assert.deepEqual(store.getSnapshot().permissions.options.map((o) => o.value), ['read-only'])
  // 同一对输入必须复用同一个对象:快照每帧都产出,而菜单渲染读 identity。
  assert.equal(store.getSnapshot().permissions, store.getSnapshot().permissions)
})

test('没有 permissions 投影的会话隐藏权限入口,即使目录已有缓存', () => {
  const store = createSessionStore()
  store.setPermissionCatalog({ options: [{ value: 'read-only', name: 'Read only' }] })
  assert.equal(store.getSnapshot().permissions, null)
})

test('控制流订阅名未变:control 与 events 仍在启动时登记', () => {
  const { subscriptions } = harness()
  const endpoints = subscriptions.map((entry) => entry.endpoint)
  assert.ok(endpoints.includes(STREAM.control))
  assert.ok(endpoints.includes(STREAM.events))
  assert.equal(HOST.pluginManagerChanged, 'host/plugin-manager-changed')
})
