/**
 * 子代理的失败/结束绝不能弹系统通知。
 *
 * 触发链(截图里那条 "后台任务失败:resume failed for session ..."):
 *   host ctx.on("agent/error") → api-session/error → 扩展 $events emit
 *   → host/agent-error 帧 → 非当前会话 → onBackgroundTurnFailure
 *   → notifier.reportFailure → chrome.notifications.create
 *
 * 这条路上唯一的闸门是"这个会话是不是当前打开的那个"。子代理就是**必然**
 * 命中它:侧栏 paging 子代理转录时 state.sessionId = childId,但
 * service.currentSessionId 停在父会话(loadSubagentHistory 只换 follow 地址、
 * 不换 store 的主人),于是 isCurrent(childId) 恒为 false —— 子代理的每一次
 * 失败都走背景分支。
 *
 * Mac 端的等价闸门是硬写的:
 *   AgentNotificationCenter.swift post():  guard !subject.isSubagent else { return }
 *   AppModel.swift: AgentNotificationSubject(isSubagent: summary.origin == "subagent")
 * 理由写在 AgentNotification.swift:239 —— "A subagent finishing is a step inside
 * its parent's turn, not the end of the user's task, so it never notifies"。
 * 浏览器半边缺这一条,所以子代理的异常被端到了 macOS 通知中心。
 *
 * 两条互不相通的出口都要挡(它们各有一个 notifier 实例):
 *   1. 侧栏:帧偷看拿到失败详情 → reportFailure
 *   2. service worker:轮询 session.list 的 running→idle → observeStatus
 * 判定一律用名单里的 origin:"subagent"(与会话头部的 origin 同源,host 的
 * listFields),不猜 id 形状。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { createBackgroundNotifier, pollSessionStatuses } from '../src/features/notifications/background-notifier.js'

const ROOT = 'session-9f1b0754-c05a-453d-b913-6336671848fd'
const CHILD = '85e28bd3-2b1f-4e2a-9c77-1d0e6f8a4c31'

const row = (sessionId, extra = {}) => ({ sessionId, running: false, updatedAt: 1, ...extra })

/// 一个连着 substore 的 service + 收到的失败回调。
function serviceHarness() {
  const failures = []
  const service = createSessionService({
    subscribe() {}, unsubscribe() {}, async call() { return {} }
  }, { onBackgroundTurnFailure: (id, message) => failures.push([id, message]) })
  service.listStore.replaceAll([row(ROOT), row(CHILD, { origin: 'subagent', parentSessionId: ROOT })])
  return { service, failures }
}

const emitError = (service, sessionId, message) => service.handleMuxFrame({
  type: 'item', streamId: 'events',
  value: { type: 'emit', event: 'api-session/error', args: [sessionId, message] }
})

const followEndError = (service, sessionId, message) => service.handleMuxFrame({
  type: 'item', streamId: `follow:${sessionId}`,
  value: {
    type: 'item', cursor: 3,
    event: {
      type: 'turn/end', seq: 2, time: 1000,
      data: { turn: 1, reason: { kind: 'error', error: { message } } }
    }
  }
})

test('service:子代理的后台 agent-error 不进系统通知', () => {
  const { service, failures } = serviceHarness()
  service.open(ROOT)
  emitError(service, CHILD, 'resume failed for session "' + CHILD + '"')
  assert.deepEqual(failures, [],
    '子代理的 api-session/error 被端成了系统通知,实际 ' + JSON.stringify(failures))
  // 行上的红点仍然要亮:那是"有几条你没看过"的账,不是系统通知。
  assert.equal(service.listStore.isErrored(CHILD), true, '子代理行的失败红点不该被一起吞掉')
})

test('service:子代理 follow 流的出错 turn/end 也不进系统通知', () => {
  const { service, failures } = serviceHarness()
  service.open(ROOT)
  followEndError(service, CHILD, 'subagent blew up')
  assert.deepEqual(failures, [], '子代理 turn/end 的失败仍是背景分支,实际 ' + JSON.stringify(failures))
  assert.equal(service.listStore.isErrored(CHILD), true)
})

test('service:根会话的后台失败照常上报(闸门没把通知整条关掉)', () => {
  const { service, failures } = serviceHarness()
  service.open('session-other')
  // 跑起来过才算"用户的后台任务" —— 见 resume-failure-notification.spec.mjs。
  service.listStore.setStatus(ROOT, true)
  emitError(service, ROOT, 'backend crash')
  followEndError(service, ROOT, 'turn crash')
  assert.deepEqual(failures, [[ROOT, 'backend crash'], [ROOT, 'turn crash']])
})

test('service:名单里没有的会话按非子代理处理(不知道就不拦)', () => {
  const { service, failures } = serviceHarness()
  service.open(ROOT)
  // host/session-status 可能早于 host/session-added 到,名单里还没有这一行,
  // 但它确实在跑:这种"不知道 origin"的会话仍旧放行,免得真失败被静音。
  service.listStore.setStatus('session-unknown', true)
  emitError(service, 'session-unknown', 'boom')
  assert.deepEqual(failures, [['session-unknown', 'boom']],
    '拿不到 origin 时保守放行,免得把真正的后台失败也静音')
})

test('listStore:origin == "subagent" 才是子代理(fork 不是)', () => {
  const { service } = serviceHarness()
  service.listStore.replaceAll([
    row(ROOT), row(CHILD, { origin: 'subagent', parentSessionId: ROOT }),
    row('session-forked', { parentSessionId: ROOT })
  ])
  const list = service.listStore
  assert.equal(list.isSubagent(CHILD), true)
  assert.equal(list.isSubagent(ROOT), false)
  assert.equal(list.isSubagent('session-forked'), false, '普通 fork 不是子代理')
  assert.equal(list.isSubagent(null), false)
  assert.equal(list.isSubagent('dsh-unknown'), false)
})

/// notify() 是 fire-and-forget 的 async,断言前让微任务跑完。
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/// 通知器测试桩:记录每次 notifications.create。
function notifierHarness() {
  const created = []
  const persisted = []
  const notifier = createBackgroundNotifier({
    notifications: { create(id, options) { created.push({ id, ...options }) } },
    settings: { getNotificationsEnabled: async () => true, getLang: async () => 'zh' },
    storage: { get: async () => ({}), set: async (value) => { persisted.push(value) }, remove: async () => {} }
  })
  return { notifier, created, persisted }
}

test('notifier:子代理 running→idle 不发通知,也不进运行集合', async () => {
  const { notifier, created, persisted } = notifierHarness()
  await notifier.loadRunning()
  notifier.observeStatus(CHILD, true, true)
  notifier.observeStatus(CHILD, false, true)
  await flush()
  assert.deepEqual(created, [], '子代理结束不该弹完成通知,实际 ' + JSON.stringify(created))
  assert.deepEqual(persisted, [], '子代理的运行态不该进持久化集合,实际 ' + JSON.stringify(persisted))
})

test('notifier:修复前留在 storage 里的子代理 id 会被清掉,不永远白读', async () => {
  const created = []
  let stored = [CHILD]
  const notifier = createBackgroundNotifier({
    notifications: { create(id, options) { created.push({ id, ...options }) } },
    settings: { getNotificationsEnabled: async () => true, getLang: async () => 'zh' },
    storage: {
      get: async () => ({ dsh_running_sessions: stored }),
      set: async (value) => { stored = value.dsh_running_sessions },
      remove: async () => {}
    }
  })
  await notifier.loadRunning()
  notifier.observeStatus(CHILD, false, true)
  await flush()
  assert.deepEqual(created, [])
  // 运行集合现在存成 { sessionId: 开始时刻 };旧版的数组照样读得进来,写回时换成新格式。
  assert.deepEqual(stored, {}, '旧版写进去的子代理 id 应当被摘掉,实际 ' + JSON.stringify(stored))
})

test('notifier:轮询把 origin 传给 observeStatus —— 子代理行同样被挡', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  const api = { call: async () => ({ items: [
    { sessionId: ROOT, running: true },
    { sessionId: CHILD, running: true, origin: 'subagent' }
  ] }) }
  await pollSessionStatuses(api, notifier)
  // 两根都在跑;根会话结束后必须通知,子代理结束后必须安静。
  const done = { call: async () => ({ items: [
    { sessionId: ROOT, running: false },
    { sessionId: CHILD, running: false, origin: 'subagent' }
  ] }) }
  await pollSessionStatuses(done, notifier)
  await flush()
  assert.equal(created.length, 1, '只应剩根会话那一条,实际 ' + JSON.stringify(created))
  assert.match(created[0].id, new RegExp('dsh-' + ROOT + '-'))
})

test('notifier:reportFailure 仍照发(它不是子代理路径,由调用方把关)', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  notifier.reportFailure(ROOT, 'backend crash')
  await flush()
  assert.equal(created.length, 1)
  assert.equal(created[0].message, '后台任务失败:backend crash')
})
