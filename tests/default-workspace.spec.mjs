/**
 * DSH 0.1.7 首次使用的默认工作区(workspace/initializeDefault):
 * 请求形状 {request:{directoryName,title}}、ok 无 value 视为首次使用已结束、
 * 拿到的行立即并入本地列表;本地预判条件对齐 web restoreSelection。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWorkspaceService } from '../src/features/workspaces/workspace-service.js'
import { isFirstUse, initializeDefaultWorkspace } from '../src/features/workspaces/default-workspace.js'
import { RPC } from '../src/platform/dsh/rpc-methods.js'
import { setLang } from '../src/shared/i18n.js'

function harness(respond) {
  const calls = []
  const connection = {
    subscribe() {},
    onFrame() {},
    async call(method, args) {
      calls.push({ method, args })
      return respond(method, args)
    }
  }
  return { service: createWorkspaceService(connection), calls }
}

const DEFAULT = { workspaceId: 'w1', title: '默认工作区', path: '/Users/u/Documents/deepseek-harness/默认工作区', sessionIds: [] }

test('RPC 名与请求形状;目录名 = 本地化标题', async () => {
  assert.equal(RPC.workspaceInitializeDefault, 'workspace/initializeDefault')
  const { service, calls } = harness(() => ({ workspace: DEFAULT }))
  setLang('zh')
  assert.deepEqual(await initializeDefaultWorkspace(service), DEFAULT)
  setLang('en')
  await initializeDefaultWorkspace(service)
  setLang('zh')
  assert.deepEqual(calls.map((call) => [call.method, call.args]), [
    ['workspace/initializeDefault', { request: { directoryName: '默认工作区', title: '默认工作区' } }],
    ['workspace/initializeDefault', { request: { directoryName: 'Default workspace', title: 'Default workspace' } }]
  ])
})

test('拿到的默认工作区立即并入本地列表并通知一次;重复返回同一行不重复并入', async () => {
  const { service } = harness(() => ({ workspace: DEFAULT }))
  let notified = 0
  service.subscribe(() => { notified += 1 })
  await service.initializeDefault({ directoryName: 'x', title: 'x' })
  await service.initializeDefault({ directoryName: 'x', title: 'x' })
  assert.deepEqual(service.workspaces, [DEFAULT])
  assert.equal(notified, 1)
})

test('首次使用已结束:宿主回 ok 无 value → null,本地列表不变', async () => {
  const { service } = harness(() => undefined)
  assert.equal(await service.initializeDefault({ directoryName: 'x', title: 'x' }), null)
  assert.deepEqual(service.workspaces, [])
})

test('失败照常抛出,由调用方提示', async () => {
  const { service } = harness(() => { throw Object.assign(new Error('conflict'), { code: 'gateway/bad-request' }) })
  await assert.rejects(initializeDefaultWorkspace(service), /conflict/)
})

test('isFirstUse:已选目录 / 有工作区 / 有会话 / 有归档任一非空都不是首次使用', () => {
  assert.equal(isFirstUse({}), true)
  assert.equal(isFirstUse({ selected: DEFAULT }), false)
  assert.equal(isFirstUse({ workspaces: [DEFAULT] }), false)
  assert.equal(isFirstUse({ sessions: [{ sessionId: 's1' }] }), false)
  assert.equal(isFirstUse({ archivedSessionIds: ['s0'] }), false)
})
