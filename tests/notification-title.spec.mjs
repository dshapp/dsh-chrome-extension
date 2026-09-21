/**
 * 通知标题必须是具体的任务内容,而不是通用的"后台任务完成"。
 *
 * 完成通知与失败通知是两条独立的出口,各由不同的 notifier 实例产生:
 *   1. service worker:轮询 session.list 的 running→idle → observeStatus
 *      标题来自同一行的 projections.values.title;
 *   2. 侧栏:帧偷看拿到失败详情 → reportFailure
 *      标题来自 listStore 的标题投影(session-service 查好后传入)。
 *
 * 两处都遵循同一条规则:有具体标题就原样展示,没有(冷启动、模型还没生成
 * 标题)才退回通用文案;过长的标题按字符截断,避免通知气泡溢出。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { createBackgroundNotifier, pollSessionStatuses } from '../src/features/notifications/background-notifier.js'

const ROOT = 'session-9f1b0754-c05a-453d-b913-6336671848fd'
const TITLE = '修复登录页的重定向循环'

/// notify() 是 fire-and-forget 的 async,断言前让微任务跑完。
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/// 通知器测试桩:记录每次 notifications.create 的完整选项。
function notifierHarness() {
  const created = []
  const notifier = createBackgroundNotifier({
    notifications: { create(id, options) { created.push({ id, ...options }) } },
    settings: { getNotificationsEnabled: async () => true, getLang: async () => 'zh' },
    storage: { get: async () => ({}), set: async () => {}, remove: async () => {} }
  })
  return { notifier, created }
}

test('notifier:完成通知的标题是会话标题(具体任务内容)', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  notifier.observeStatus(ROOT, true)
  notifier.observeStatus(ROOT, false, false, TITLE)
  await flush()
  assert.equal(created.length, 1)
  assert.equal(created[0].title, TITLE, '标题应当是具体任务内容,实际 ' + JSON.stringify(created[0].title))
  assert.equal(created[0].message, '后台任务已完成')
})

test('notifier:没有标题时完成通知退回通用文案', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  notifier.observeStatus(ROOT, true)
  notifier.observeStatus(ROOT, false)
  await flush()
  assert.equal(created[0].title, '任务完成')
})

test('notifier:过长的标题按字符截断,通知气泡不溢出', async () => {
  const { notifier, created } = notifierHarness()
  const long = '很长'.repeat(100)
  await notifier.loadRunning()
  notifier.observeStatus(ROOT, true)
  notifier.observeStatus(ROOT, false, false, long)
  await flush()
  assert.equal(created[0].title, long.slice(0, 80) + '…')
})

test('notifier:轮询把 session.list 的标题透传给完成通知', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  const running = { call: async () => ({ items: [
    { sessionId: ROOT, running: true, projections: { values: { title: TITLE } } }
  ] }) }
  await pollSessionStatuses(running, notifier)
  const done = { call: async () => ({ items: [
    { sessionId: ROOT, running: false, projections: { values: { title: TITLE } } }
  ] }) }
  await pollSessionStatuses(done, notifier)
  await flush()
  assert.equal(created.length, 1)
  assert.equal(created[0].title, TITLE)
})

test('notifier:失败通知的标题同样是具体任务内容', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  notifier.reportFailure(ROOT, 'backend crash', TITLE)
  await flush()
  assert.equal(created.length, 1)
  assert.equal(created[0].title, TITLE)
  assert.equal(created[0].message, '后台任务失败:backend crash')
})

test('notifier:失败通知缺标题时退回通用文案', async () => {
  const { notifier, created } = notifierHarness()
  await notifier.loadRunning()
  notifier.reportFailure(ROOT, 'backend crash')
  await flush()
  assert.equal(created[0].title, '任务出错')
})

test('service:后台失败回调带上该会话的标题', () => {
  const failures = []
  const service = createSessionService({
    subscribe() {}, unsubscribe() {}, async call() { return {} }
  }, { onBackgroundTurnFailure: (id, message, title) => failures.push([id, message, title]) })
  service.listStore.replaceAll([{ sessionId: ROOT, running: false, updatedAt: 1 }])
  service.listStore.setTitle(ROOT, TITLE)
  service.open('session-other')
  service.handleHostFrame({
    type: 'item', streamId: 'events',
    payload: { type: 'host/agent-error', sessionId: ROOT, message: 'boom' }
  })
  assert.deepEqual(failures, [[ROOT, 'boom', TITLE]])
})
