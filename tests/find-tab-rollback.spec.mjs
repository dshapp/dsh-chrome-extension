/**
 * find_tab 失败时不得把会话绑到那个标签页上。
 *
 * find_tab 先在 sessionTabs 里登记标签页、再 await attach();attach 被拒
 * (chrome:// 等不可调试页面、file: 没开文件访问权限)时函数抛错,但登记
 * 已经落地。close_session 只认 sessionTabs —— 它会把会话指向的标签页直接
 * remove 掉。于是"借用户当前标签页"失败后,任务清理时删掉的是用户自己的
 * 标签页:{"closed":1,"kept":[]}。
 *
 * 失败必须回滚登记,让会话保持原样(通常是"没有标签页")。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')

/** 最小 chrome 桩;attach 可覆写以模拟不可调试目标。 */
function loadWorker({ attachError } = {}) {
  const handler = { addListener() {}, removeListener() {} }
  const userTab = { id: 700, url: 'https://user.example/private', active: true, groupId: -1 }
  const chrome = {
    runtime: { id: 'test', getManifest: () => ({ version: '0' }), getPlatformInfo: async () => ({ os: 'mac' }),
      onMessage: handler, onStartup: handler, onInstalled: handler },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: handler },
    alarms: { create() {}, onAlarm: handler },
    tabs: {
      get: async (id) => ({ ...userTab, id }),
      query: async (filter) => (filter && filter.active ? [userTab] : [userTab]),
      create: async () => ({ id: 1 }), update: async () => ({}),
      remove: async () => {}, group: async () => 1,
      onUpdated: handler, onRemoved: handler,
    },
    tabGroups: { get: async () => ({}), update: async () => {} },
    windows: { update: async () => {} },
    debugger: {
      attach: async () => { if (attachError) throw new Error(attachError) },
      detach: async () => {}, sendCommand: async () => ({}),
      onDetach: handler, onEvent: handler,
    },
  }
  const internals = new Function('chrome', 'WebSocket', 'console',
    `${source}\n;return { tools, sessionTabs, borrowedTabs };`)
  const WebSocketStub = class { constructor() {} addEventListener() {} send() {} close() {} }
  return internals(chrome, WebSocketStub, console)
}

const NOT_DEBUGGABLE = 'Cannot attach to this target'

test('find_tab(active:true):attach 失败后会话不得指向用户的标签页', async () => {
  const worker = loadWorker({ attachError: NOT_DEBUGGABLE })
  await assert.rejects(
    () => worker.tools.find_tab({ session: 's1', active: true }),
    new RegExp(NOT_DEBUGGABLE)
  )
  assert.equal(worker.sessionTabs.get('s1'), undefined,
    'attach 失败的会话仍指向 tab 700 —— 之后的 close_session 会删掉用户自己的标签页')
})

test('find_tab(url):attach 失败后会话不得指向那个标签页', async () => {
  const worker = loadWorker({ attachError: NOT_DEBUGGABLE })
  await assert.rejects(
    () => worker.tools.find_tab({ session: 's2', url: 'https://user.example/private' }),
    new RegExp(NOT_DEBUGGABLE)
  )
  assert.equal(worker.sessionTabs.get('s2'), undefined,
    'attach 失败的会话仍指向 tab 700 —— 之后的 close_session 会删掉用户自己的标签页')
})

test('find_tab 失败后 close_session 不得删除用户的标签页(端到端)', async () => {
  const worker = loadWorker({ attachError: NOT_DEBUGGABLE })
  await assert.rejects(() => worker.tools.find_tab({ session: 's3', active: true }))
  const result = await worker.tools.close_session({ session: 's3' })
  assert.deepEqual(result.closed, 0,
    `close_session 报告关闭了 ${result.closed} 个标签页;用户的标签页不该被这次失败的借用牵连`)
})
