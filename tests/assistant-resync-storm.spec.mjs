/**
 * follow 流丢帧重开之后,旧代际的"尾巴帧"不能再逐帧触发重开。
 *
 * reopenFollow 的注释写着丢帧后的旧代际帧(中段挂载、陈旧尾巴)"在被清空的期望下
 * 不会再触发重开,静默等 settle 兜底"。但 reopenFollow 会把 assistantRevision 归零,
 * 而 revision 校验发生在 foldAssistantStreamFrame 的**最前面**(早于按 type 的
 * 期望判断):尾巴帧携带的 revision 必然对不上"0+1",于是每个尾巴帧都会再
 * reopenFollow 一次 —— 每帧一次 unsubscribe + subscribe 的风暴,与注释意图相反。
 * 丢帧瞬间尾巴有多长,就重开多少次。
 *
 * 修法:reopenFollow 立起 assistantResyncing,窗口内到达的帧(它们只可能是旧代际
 * 尾巴)在 revision 校验之前就静默丢弃;新快照重新武装 baseline 时清除该窗口。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'

function harness() {
  const events = []
  const connection = {
    subscribe(id) { events.push('sub ' + id) },
    unsubscribe(id) { events.push('unsub ' + id) },
    async call() { return {} }
  }
  return { service: createSessionService(connection), events }
}

async function opened() {
  const h = harness()
  await h.service.open('s1')
  h.events.length = 0 // 忽略 open 自己的三条订阅
  return h
}

const snapshot = (revision, activeAttempt) => ({
  type: 'item', streamId: 'follow:s1',
  value: {
    type: 'snapshot', cursor: 10,
    assistantStream: { ...(revision == null ? {} : { revision }), activeAttempt }
  }
})
const streamFrame = (frame) => ({ type: 'item', streamId: 'follow:s1', value: { type: 'assistant-stream', frame } })
const attempt = (nextIndex = 3) => ({ attemptId: 'a1', nextIndex })
const chunk = (extra) => ({ type: 'chunk', attemptId: 'a1', index: 3, ...extra })

test('丢帧后的尾巴帧只重开一次,不再逐帧 unsubscribe/subscribe', async () => {
  const { service, events } = await opened()
  service.handleMuxFrame(snapshot(5, attempt()))
  // 宿主已推进到第 5 代;带着旧代际 rev=5 的尾巴帧,期望是 6,必然失配。
  for (let i = 0; i < 6; i++) service.handleMuxFrame(streamFrame(chunk({ revision: 5 })))
  assert.deepEqual(events, ['unsub follow:s1', 'sub follow:s1'],
    '六个尾巴帧只允许重开一次,实际 ' + JSON.stringify(events))
})

test('新快照重新武装 baseline 后,代际校验照常生效', async () => {
  const { service, events } = await opened()
  service.handleMuxFrame(snapshot(5, attempt()))
  service.handleMuxFrame(streamFrame(chunk({ revision: 5 }))) // 触发一次重开
  assert.equal(events.length, 2)

  // 重开后的新快照把 baseline 重新武装到第 5 代,窗口结束。
  service.handleMuxFrame(snapshot(5, attempt()))
  // 再来一个旧代际帧:这次必须重新按规则失配并重开(窗口不能被永久关闭)。
  service.handleMuxFrame(streamFrame(chunk({ revision: 5 })))
  assert.deepEqual(events, ['unsub follow:s1', 'sub follow:s1', 'unsub follow:s1', 'sub follow:s1'],
    'baseline 重新武装后必须恢复代际校验,实际 ' + JSON.stringify(events))
})

test('重开窗口内到达的尾部帧不再重开,但窗口外的正常续帧被接受', async () => {
  const { service, events } = await opened()
  service.handleMuxFrame(snapshot(5, attempt()))
  service.handleMuxFrame(streamFrame(chunk({ revision: 5 }))) // 重开一次
  service.handleMuxFrame(streamFrame(chunk({ revision: 5 }))) // 尾巴,静默
  service.handleMuxFrame(streamFrame(chunk({ revision: 5 }))) // 尾巴,静默
  assert.equal(events.length, 2, '尾巴帧不能再重开')
  const before = service.getRuntimeSnapshot()
  assert.ok(before, '快照可读')
  // 新快照重新武装 baseline(activeAttempt.nextIndex=3);紧随其后的 +1 代帧
  // 必须被接受(不重开、不丢弃):继续同一个 attempt、index 接上期望。
  service.handleMuxFrame(snapshot(5, attempt(3)))
  service.handleMuxFrame(streamFrame({ type: 'chunk', attemptId: 'a1', index: 3, chunk: { text: 'hello' }, revision: 6 }))
  assert.equal(events.length, 2, '正常续帧不该触发重开,实际 ' + JSON.stringify(events))
  // 收尾帧接续下一格,同样只认代际 +1。
  service.handleMuxFrame(streamFrame({ type: 'end', attemptId: 'a1', index: 4, revision: 7 }))
  assert.equal(events.length, 2, '收尾帧也不该触发重开,实际 ' + JSON.stringify(events))
})

test('没有 revision 字段的旧宿主,尾巴帧同样只重开一次', async () => {
  const { service, events } = await opened()
  service.handleMuxFrame(snapshot(null, attempt(3)))
  // index 对不上期望(3),且不带 revision:老的 index 稠密校验路径。
  for (let i = 0; i < 5; i++) service.handleMuxFrame(streamFrame(chunk({ index: 99 })))
  assert.deepEqual(events, ['unsub follow:s1', 'sub follow:s1'],
    '旧宿主也不能逐帧重开,实际 ' + JSON.stringify(events))
})

test('重开窗口不会跨会话泄漏', async () => {
  const { service, events } = await opened()
  service.handleMuxFrame(snapshot(5, attempt()))
  service.handleMuxFrame(streamFrame(chunk({ revision: 5 }))) // 重开,s1 进入重开窗口
  assert.equal(events.length, 2)
  // 切到另一个会话后,新会话的 baseline 必须能正常武装,窗口不该残留。
  await service.open('s2')
  events.length = 0
  service.handleMuxFrame({ type: 'item', streamId: 'follow:s2', value: {
    type: 'snapshot', cursor: 1, assistantStream: { revision: 4, activeAttempt: attempt(0) }
  } })
  service.handleMuxFrame({ type: 'item', streamId: 'follow:s2', value: { type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'a1', index: 0, chunk: { text: 'x' }, revision: 5 } } })
  assert.deepEqual(events, [], '新会话的正常 +1 代帧不该被旧会话的重开窗口吞掉,实际 ' + JSON.stringify(events))
})
