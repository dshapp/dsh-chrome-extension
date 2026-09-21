/**
 * agent 级错误必须留下一个可见的错误行。
 *
 * 宿主用 "api-session/error" 报告 agent 级失败(agent/error,以及
 * resolveObservedAgent 失败)。这条事件没有 seq、也不属于任何一轮,所以
 * session-service 合成一条 { type: 'turn/end', seq: -1, data: { turn: 0 } } 的
 * 本地事件,注释写明目的是"让它可见"。
 *
 * 问题在于 store 侧:turn/end 的 error 分支只填**已存在**的
 * turn-error:<turn> 上下文,而那个上下文只有真正的 turn/start 才会创建。
 * 宿主轮次从 1 开始,合成事件的 turn 是 0,于是永远没有 turn-error:0,
 * pending.message 一直为 null,rebuildNodes 一行都不产出 —— 用户只看到
 * 转圈停下,既没有错误行也没有 toast(当前会话分支不走 onBackgroundTurnFailure)。
 *
 * 修好后:即使没有 turn/start,一条出错 turn/end 也能就地补出错误行。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { createSessionStore } from '../src/features/sessions/session-store.js'

function errorRows(snapshot) {
  return (snapshot.nodes ?? []).filter((node) => node.kind === 'turnError')
}

const endError = (turn, message, seq = 2) => ({
  type: 'turn/end', seq, time: 1000 + seq,
  data: { turn, reason: { kind: 'error', error: { message } } }
})

test('store:没有 turn/start 的出错 turn/end 也留下错误行', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent(endError(0, 'agent blew up', -1))
  const snapshot = store.getSnapshot()
  const rows = errorRows(snapshot)
  assert.equal(rows.length, 1, 'agent 级错误应当有一行可见错误,实际 ' + rows.length)
  assert.equal(rows[0].message, 'agent blew up')
  assert.equal(snapshot.running, false, '出错后不应继续显示运行中')
})

test('store:正常轮次的出错行为不变(仍然是那一行)', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent({ type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } })
  store.applyEvent(endError(1, 'boom', 2))
  const rows = errorRows(store.getSnapshot())
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].message, 'boom')
})

test('service:host/agent-error 在当前会话产出错误行', () => {
  const connection = {
    subscribe() {},
    unsubscribe() {},
    async call() { return {} }
  }
  const service = createSessionService(connection)
  service.open('s1')
  service.handleHostFrame({
    payload: { type: 'host/agent-error', sessionId: 's1', message: 'agent crashed' }
  })
  const snapshot = service.getRuntimeSnapshot()
  const rows = errorRows(snapshot)
  assert.equal(rows.length, 1, 'agent-error 应有一行可见错误,实际 ' + rows.length)
  assert.equal(rows[0].message, 'agent crashed')
})

test('service:背景会话的 agent-error 不产出当前快照的行', () => {
  const failures = []
  const service = createSessionService({
    subscribe() {}, unsubscribe() {}, async call() { return {} }
  }, { onBackgroundTurnFailure: (id, message) => failures.push([id, message]) })
  service.open('s1')
  // 通知闸门只放行"本客户端见过它在跑"的会话(见 resume-failure-notification.spec.mjs)。
  service.listStore.setStatus('other', true)
  service.handleHostFrame({
    payload: { type: 'host/agent-error', sessionId: 'other', message: 'background crash' }
  })
  assert.equal(errorRows(service.getRuntimeSnapshot()).length, 0)
  assert.deepEqual(failures, [['other', 'background crash']])
})
