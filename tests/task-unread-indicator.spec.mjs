/**
 * 工具栏图标上的红 / 黄 / 绿点(任务未读)。
 *
 * 以前没有这个点,侧栏关着时跑完的任务只有一条系统通知,打开侧栏后行上的点也没了。
 * 现在:SW 记一份带过期时间的未读(绿 2h、红 / 黄 12h),工具栏画一个点,侧栏的会话行读同一份;
 * 用户正看着这条会话(侧栏可见 + 侧栏或窗口在前台)、点了通知、会话被删除或到期时消失。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INDICATORS, UNREAD_TTL_MS, nextUnreadExpiry, pruneExpired, resolveIndicator, unreadBySession, unreadKey
} from '../src/features/notifications/unread-policy.js'
import {
  createTaskUnreadCoordinator, TASK_UNREAD_EXPIRY_ALARM, TASK_UNREAD_KEY
} from '../src/features/notifications/task-unread.js'
import { createPresenceRegistry, createPresenceReporter, PANEL_PRESENCE_PORT } from '../src/features/notifications/panel-presence.js'
import { createTaskUnreadMirror } from '../src/features/notifications/task-unread-mirror.js'
import { createBackgroundNotifier, pollSessionStatuses } from '../src/features/notifications/background-notifier.js'
import { createActionDotIndicator, dotGeometry } from '../src/platform/chrome/action-dot-indicator.js'
import { createSessionListStore } from '../src/features/sessions/session-list-store.js'
import { createSessionService } from '../src/features/sessions/session-service.js'

const A = 'session-aaaaaaaa-0000-0000-0000-000000000001'
const B = 'session-bbbbbbbb-0000-0000-0000-000000000002'
const HOUR = 3_600_000
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])) },
    async set(value) { Object.assign(data, structuredClone(value)) },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k] }
  }
}

function harness({ seen = new Set(), start = 1_000_000 } = {}) {
  const clock = { now: start }
  const storage = memoryStorage()
  const shown = []
  const alarms = []
  const cleared = []
  const unread = createTaskUnreadCoordinator({
    storage,
    alarms: {
      async create(name, info) { alarms.push({ name, ...info }) },
      async clear(name) { alarms.push({ name, cleared: true }) }
    },
    indicator: { async show(dot) { shown.push(dot) } },
    isSeen: (id) => seen.has(id),
    describe: (top) => top.status + ':' + top.count,
    onSessionCleared: (id) => cleared.push(id),
    now: () => clock.now
  })
  return { unread, storage, shown, alarms, cleared, clock, seen, last: () => shown.at(-1) }
}

// ---------- 纯规则 ----------

test('policy:同一时刻只画最要紧的点(红 > 黄 > 绿),count 按会话数计', () => {
  const t0 = 1
  const unread = {
    [unreadKey(A, 'success')]: { sessionId: A, status: 'success', createdAt: t0 },
    [unreadKey(A, 'attention')]: { sessionId: A, status: 'attention', createdAt: t0 },
    [unreadKey(B, 'attention')]: { sessionId: B, status: 'attention', createdAt: t0 }
  }
  assert.deepEqual(resolveIndicator(unread), { status: 'attention', color: INDICATORS.attention.color, titleKey: 'taskIndicator.attention', count: 2 })
  unread[unreadKey(B, 'failure')] = { sessionId: B, status: 'failure', createdAt: t0 }
  assert.equal(resolveIndicator(unread).status, 'failure')
  assert.equal(resolveIndicator(unread).count, 1)
  assert.equal(resolveIndicator({}), null)
  assert.deepEqual(unreadBySession(unread)[B], { success: false, attention: true, failure: true })
})

test('policy:绿 2 小时、红 / 黄 12 小时过期;没有 createdAt 的旧数据直接算过期', () => {
  const unread = {
    s: { sessionId: A, status: 'success', createdAt: 10 },
    f: { sessionId: B, status: 'failure', createdAt: 10 },
    legacy: { sessionId: B, status: 'success' }
  }
  assert.equal(nextUnreadExpiry(unread), 10 + UNREAD_TTL_MS.success)
  assert.equal(pruneExpired(unread, 11), 1, '只有缺 createdAt 的那条被清')
  assert.equal(pruneExpired(unread, 10 + 2 * HOUR), 1)
  assert.deepEqual(Object.keys(unread), ['f'])
  assert.equal(pruneExpired(unread, 10 + 12 * HOUR), 1)
})

// ---------- SW 记账 ----------

test('coordinator:跑完记绿点,悬停提示带数量;看过后撤点并收掉系统通知', async () => {
  const h = harness()
  const result = await h.unread.record({ sessionId: A, status: 'success', title: '修登录' })
  assert.equal(result.reason, 'recorded')
  assert.deepEqual(h.last(), { color: INDICATORS.success.color, title: 'success:1' })
  assert.equal(h.storage.data[TASK_UNREAD_KEY].unread[unreadKey(A, 'success')].title, '修登录')
  assert.equal(await h.unread.markSeen(A), true)
  assert.equal(h.last(), null)
  assert.deepEqual(h.cleared, [A])
})

test('coordinator:到点自动消失 —— 闹钟排在最早一条到期时,到点后撤点', async () => {
  const h = harness()
  await h.unread.record({ sessionId: A, status: 'success' })
  const alarm = h.alarms.at(-1)
  assert.equal(alarm.name, TASK_UNREAD_EXPIRY_ALARM)
  assert.equal(alarm.when, h.clock.now + 2 * HOUR)
  h.clock.now += 2 * HOUR
  assert.equal(await h.unread.handleAlarm({ name: TASK_UNREAD_EXPIRY_ALARM }), true)
  assert.equal(h.last(), null, '过期后图标应恢复原样')
  assert.deepEqual(h.storage.data[TASK_UNREAD_KEY].unread, {})
  assert.equal(h.alarms.at(-1).cleared, true, '没有未读时闹钟撤掉')
})

test('coordinator:红点比绿点留得久 —— 绿点过期后仍显示红点,12 小时后才撤', async () => {
  const h = harness()
  await h.unread.record({ sessionId: A, status: 'success' })
  await h.unread.record({ sessionId: B, status: 'failure' })
  assert.equal(h.last().color, INDICATORS.failure.color)
  h.clock.now += 3 * HOUR
  await h.unread.refresh()
  assert.equal(h.last().color, INDICATORS.failure.color)
  assert.equal(h.last().title, 'failure:1')
  h.clock.now += 9 * HOUR
  await h.unread.refresh()
  assert.equal(h.last(), null)
})

test('coordinator:旧版留下的、没有 createdAt 的未读,启动刷新即清', async () => {
  const h = harness()
  h.storage.data[TASK_UNREAD_KEY] = { unread: { x: { sessionId: A, status: 'success' } }, seenKeys: [] }
  await h.unread.refresh()
  assert.equal(h.last(), null)
  assert.deepEqual(h.storage.data[TASK_UNREAD_KEY].unread, {})
})

test('coordinator:用户正看着这条会话 → 不记未读', async () => {
  const h = harness({ seen: new Set([A]) })
  const result = await h.unread.record({ sessionId: A, status: 'success' })
  assert.equal(result.reason, 'seen')
  assert.deepEqual(h.storage.data[TASK_UNREAD_KEY]?.unread ?? {}, {})
})

test('coordinator:这一轮已经报过失败,轮询看到的「跑完」不再补一个绿点(调用方据此不弹完成通知)', async () => {
  const h = harness()
  const since = h.clock.now
  h.clock.now += 1000
  await h.unread.record({ sessionId: A, status: 'failure' })
  h.clock.now += 1000
  const result = await h.unread.record({ sessionId: A, status: 'success', since })
  assert.equal(result.reason, 'failed')
  assert.equal(h.storage.data[TASK_UNREAD_KEY].unread[unreadKey(A, 'success')], undefined)
  // 失败发生在上一轮(早于这一轮的开始):这一轮成功了,照常记绿点。
  const later = h.clock.now + 1
  h.clock.now += 5000
  assert.equal((await h.unread.record({ sessionId: A, status: 'success', since: later })).reason, 'recorded')
})

test('coordinator:轮结束时黄点撤掉;看过的挂起请求重放(重连)不再点亮', async () => {
  const h = harness()
  await h.unread.record({ sessionId: A, status: 'attention', eventId: 'ev-1' })
  assert.equal(h.last().color, INDICATORS.attention.color)
  await h.unread.markSeen(A)
  assert.equal((await h.unread.record({ sessionId: A, status: 'attention', eventId: 'ev-1' })).reason, 'seen')
  assert.equal(h.last(), null)
  await h.unread.record({ sessionId: A, status: 'attention', eventId: 'ev-2' })
  await h.unread.record({ sessionId: A, status: 'success' })
  const unread = h.storage.data[TASK_UNREAD_KEY].unread
  assert.equal(unread[unreadKey(A, 'attention')], undefined, '轮结束了,等你处理随之结算')
  assert.equal(h.last().color, INDICATORS.success.color)
})

test('coordinator:挂起请求结算(clear attention)撤黄点;删掉的会话被 retain 剪掉', async () => {
  const h = harness()
  await h.unread.record({ sessionId: A, status: 'attention', eventId: 'ev-9' })
  await h.unread.record({ sessionId: B, status: 'success' })
  await h.unread.clear(A, ['attention'])
  assert.equal(h.last().color, INDICATORS.success.color)
  assert.equal(await h.unread.retain([A]), 1)
  assert.equal(h.last(), null)
})

// ---------- 在场 ----------

test('presence:侧栏可见 + (侧栏焦点或窗口前台)算看过;压通知只认侧栏焦点;端口断开即不在场', () => {
  const registry = createPresenceRegistry()
  const port = {}
  registry.set(port, { visible: true, focused: false, windowFocused: true, sessionId: A })
  assert.equal(registry.isSeen(A), true)
  assert.equal(registry.isWatching(A), false)
  assert.equal(registry.isSeen(B), false)
  registry.set(port, { visible: true, focused: true, windowFocused: true, sessionId: A })
  assert.equal(registry.isWatching(A), true)
  registry.set(port, { visible: false, focused: false, windowFocused: true, sessionId: A })
  assert.equal(registry.isSeen(A), false, '侧栏收起后不算在看')
  registry.set(port, { visible: true, focused: false, windowFocused: false, sessionId: A })
  assert.equal(registry.isSeen(A), false, 'Chrome 在后台不算在看')
  registry.set(port, { visible: true, focused: true, sessionId: A })
  registry.remove(port)
  assert.equal(registry.isSeen(A), false)
})

test('presence reporter:连上端口并上报当前会话;只有会话真的变了 sessionChanged 才补报', async () => {
  const posted = []
  let current = A
  const runtime = { connect: ({ name }) => { assert.equal(name, PANEL_PRESENCE_PORT); return { postMessage: (m) => posted.push(m), onDisconnect: { addListener() {} } } } }
  const reporter = createPresenceReporter({
    runtime,
    windows: { getCurrent: async () => ({ focused: true }) },
    doc: { visibilityState: 'visible', hasFocus: () => false, addEventListener() {} },
    win: { addEventListener() {} },
    getSessionId: () => current,
    setTimer: () => 0,
    clearTimer: () => {}
  })
  reporter.start()
  await flush()
  assert.deepEqual(posted.at(-1), { type: 'presence', visible: true, focused: false, windowFocused: true, sessionId: A })
  reporter.sessionChanged()
  await flush()
  assert.equal(posted.length, 1, '会话没变不该重复上报')
  current = B
  reporter.sessionChanged()
  await flush()
  assert.equal(posted.at(-1).sessionId, B)
})

// ---------- 完成通知 ----------

function notifierWith(options) {
  const created = []
  const notifier = createBackgroundNotifier({
    notifications: { create(id, opts) { created.push({ id, ...opts }) } },
    settings: { getNotificationsEnabled: async () => true, getLang: async () => 'zh' },
    storage: memoryStorage(),
    ...options
  })
  return { notifier, created }
}

test('notifier:这一轮已报过失败 → 不再弹「完成」;用户正看着(侧栏焦点)→ 不弹', async () => {
  const calls = []
  const { notifier, created } = notifierWith({
    onCompleted: async (info) => { calls.push(info); return { reason: 'failed' } }
  })
  await notifier.loadRunning()
  notifier.observeStatus(A, true)
  notifier.observeStatus(A, false, false, 'T')
  await flush()
  assert.equal(created.length, 0)
  assert.equal(calls[0].sessionId, A)
  assert.equal(typeof calls[0].since, 'number')

  const watching = notifierWith({ isWatching: (id) => id === A })
  await watching.notifier.loadRunning()
  watching.notifier.observeStatus(A, true)
  watching.notifier.observeStatus(A, false)
  await flush()
  assert.equal(watching.created.length, 0)
})

test('notifier:名单里消失的会话从运行集合剪掉;旧版数组格式照样读得进来', async () => {
  const storage = memoryStorage({ dsh_running_sessions: [A, B] })
  const { notifier, created } = notifierWith({ storage })
  await notifier.loadRunning()
  await pollSessionStatuses({ call: async () => ({ items: [{ sessionId: A, running: true }] }) }, notifier)
  assert.deepEqual(Object.keys(storage.data.dsh_running_sessions), [A], 'B 已被删除,不该永远挂在运行集合里')
  await pollSessionStatuses({ call: async () => ({ items: [{ sessionId: A, running: false }] }) }, notifier)
  await flush()
  assert.equal(created.length, 1)
})

// ---------- 侧栏会话行 ----------

test('list store:SW 的未读镜像到行上;过期 / 在别处看过时行上的点一起撤掉', () => {
  const store = createSessionListStore()
  store.replaceAll([{ sessionId: A, running: true, updatedAt: 2 }, { sessionId: B, running: false, updatedAt: 1 }])
  store.setSelected(B)
  store.setStatus(A, false) // 侧栏开着时亲眼看到 A 跑完:本地绿点
  assert.equal(store.isCompleted(A), true)
  store.setPersistedUnread({ [A]: { success: true } })
  store.setPersistedUnread({})
  assert.equal(store.isCompleted(A), false, 'SW 那份过期了,本地那个点也该消失')

  store.setPersistedUnread({ [A]: { failure: true } })
  assert.equal(store.isErrored(A), true)
  assert.equal(store.isCompleted(A), true)
  store.setPersistedUnread({ [B]: { success: true } })
  assert.equal(store.isErrored(A), false)
  assert.equal(store.isCompleted(B), false, '当前正打开的会话不亮点')
  store.setSelected(A)
  store.setSelected(B)
  assert.equal(store.isCompleted(B), false)
})

test('mirror:启动读一次,storage.onChanged 时再推', async () => {
  const listeners = []
  const applied = []
  const storage = memoryStorage({ [TASK_UNREAD_KEY]: { unread: { k: { sessionId: A, status: 'success', createdAt: 1 } } } })
  createTaskUnreadMirror({ storage, onChanged: { addListener: (l) => listeners.push(l) }, apply: (v) => applied.push(v) }).start()
  await flush()
  assert.deepEqual(applied[0], { [A]: { success: true, attention: false, failure: false } })
  listeners[0]({ [TASK_UNREAD_KEY]: { newValue: { unread: {} } } }, 'local')
  assert.deepEqual(applied[1], {})
})

test('service:挂起请求出现 / 结算时回调 onAwaitingChange(喂黄点)', () => {
  const changes = []
  const service = createSessionService({ subscribe() {}, unsubscribe() {}, async call() { return {} } }, {
    onAwaitingChange: (...args) => changes.push(args)
  })
  service.listStore.replaceAll([{ sessionId: A, running: true, updatedAt: 1 }])
  service.handleMuxFrame({ type: 'item', streamId: 'events', value: {
    type: 'waterfall', agentId: A, eventId: 'ev-7', event: 'approval/request', request: { toolName: 'bash' }
  } })
  assert.deepEqual(changes, [[A, 'approval', 'ev-7']])
  service.retireInteraction('ev-7')
  assert.deepEqual(changes.at(-1), [A, null, null])
})

// ---------- 画点 ----------

function fakeCanvasEnv() {
  const ops = []
  class FakeCanvas {
    constructor(w, h) { this.w = w; this.h = h }
    getContext() {
      return {
        set globalCompositeOperation(v) { ops.push(['gco', v]) },
        set fillStyle(v) { ops.push(['fill', v]) },
        drawImage() {}, beginPath() {}, arc() {}, fill() {},
        getImageData: () => ({ size: this.w })
      }
    }
  }
  return { ops, FakeCanvas }
}

function fakeApi(calls, { setIconThrows = false } = {}) {
  return {
    runtime: {
      getURL: (p) => 'chrome-extension://x/' + p,
      getManifest: () => ({ name: 'Deepseek Harness APP', action: { default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } } })
    },
    action: {
      async setIcon(details) { calls.push(['setIcon', details]); if (setIconThrows) throw new Error('boom') },
      async setBadgeText(d) { calls.push(['badge', d.text]) },
      async setBadgeBackgroundColor(d) { calls.push(['badgeColor', d.color]) },
      async setTitle(d) { calls.push(['title', d.title]) }
    }
  }
}

test('indicator:画点用 imageData(16/32);撤点换回以 / 开头的原图路径并恢复标题', async () => {
  const calls = []
  const { ops, FakeCanvas } = fakeCanvasEnv()
  const indicator = createActionDotIndicator({
    api: fakeApi(calls),
    fetchImpl: async () => ({ ok: true, blob: async () => ({}) }),
    createBitmap: async () => ({}),
    CanvasImpl: FakeCanvas
  })
  await indicator.show({ color: '#16A34A', title: '1 个任务已完成' })
  const set = calls.find(([k]) => k === 'setIcon')[1]
  assert.deepEqual(Object.keys(set.imageData).sort(), ['16', '32'])
  assert.ok(ops.some(([k, v]) => k === 'gco' && v === 'destination-out'), '先挖一圈透明')
  assert.ok(ops.some(([k, v]) => k === 'fill' && v === '#16A34A'))
  assert.deepEqual(calls.filter(([k]) => k === 'title').at(-1), ['title', '1 个任务已完成'])
  const before = calls.length
  await indicator.show({ color: '#16A34A', title: '1 个任务已完成' })
  assert.equal(calls.length, before, '同一个点不重画')
  await indicator.show(null)
  const restored = calls.filter(([k]) => k === 'setIcon').at(-1)[1]
  assert.deepEqual(restored, { path: { 16: '/icons/icon16.png', 32: '/icons/icon32.png' } })
  assert.deepEqual(calls.at(-1), ['title', 'Deepseek Harness APP'])
  const g = dotGeometry(16)
  assert.ok(g.cx + g.r <= 16 && g.cy - g.r >= 0, '点完整落在图标内')
})

test('indicator:画不出来时退回纯色角标(空格 + 背景色)', async () => {
  const calls = []
  const indicator = createActionDotIndicator({ api: fakeApi(calls), CanvasImpl: undefined })
  await indicator.show({ color: '#DC2626', title: 'x' })
  assert.ok(calls.some(([k, v]) => k === 'badge' && v === ' '))
  assert.ok(calls.some(([k, v]) => k === 'badgeColor' && v === '#DC2626'))
})
