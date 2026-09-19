/**
 * 控制投影的版本必须逐 key 记,不能一个会话共用一个 asOfSeq。
 *
 * control 流的 projection 帧是逐 key 到达的,controlProjections 却把每个会话的
 * asOfSeq 记成"所有 key 的 seq 最大值"。这个值只能当整块快照的切点用,一旦拿它
 * 给块内所有 key 盖同一个版本,就会出现:
 *   title@10 先到 → usage@20 后到(把 asOfSeq 顶到 20)→ 切走再切回时
 *   applyCachedControl 用 20 重放 title → store 认为 title 已经到过 20 →
 *   真正更新的 title@15 被判为陈旧帧丢弃,标题永远停在旧值。
 * 同一文件里 applyHistoryValue 已经是逐 key 规则(seqs[key] ?? asOfSeq) ——
 * 控制投影这条路漏了。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'

function service() {
  return createSessionService({ subscribe() {}, unsubscribe() {}, async call() { return {} } })
}
const proj = (sessionId, key, value, seq) => ({
  type: 'item', streamId: 'control',
  value: { type: 'projection', sessionId, key, value, seq }
})

test('切走再切回后,后到的更新(< 同块其它 key 的 seq)仍然生效', async () => {
  const s = service()
  await s.open('s1')
  s.handleMuxFrame(proj('s1', 'title', 'TITLE@10', 10))
  s.handleMuxFrame(proj('s1', 'usage', 'USAGE@20', 20))
  assert.equal(s.getRuntimeSnapshot().title, 'TITLE@10')

  // applyCachedControl 会在这里重放缓存投影
  await s.open('s2')
  await s.open('s1')
  assert.equal(s.getRuntimeSnapshot().title, 'TITLE@10', '重放不该改变已有的值')

  // title@15 比 title@10 新(尽管比同块的 usage@20 小),必须被采纳
  s.handleMuxFrame(proj('s1', 'title', 'TITLE@15', 15))
  assert.equal(s.getRuntimeSnapshot().title, 'TITLE@15',
    '被同块其它 key 的高 seq 顶掉版本后,更新的帧会被误判陈旧丢弃')
})

test('真正陈旧的帧仍然被挡住(修法没把去重整个关掉)', async () => {
  const s = service()
  await s.open('s1')
  s.handleMuxFrame(proj('s1', 'title', 'TITLE@20', 20))
  s.handleMuxFrame(proj('s1', 'title', 'TITLE@5', 5))
  assert.equal(s.getRuntimeSnapshot().title, 'TITLE@20', '更旧的帧必须继续被挡住')
})

test('不同 key 各自推进版本,互不干扰', async () => {
  const s = service()
  await s.open('s1')
  s.handleMuxFrame(proj('s1', 'title', 'A', 100))
  s.handleMuxFrame(proj('s1', 'title', 'B', 200))
  // tokenUsage 的低 seq 不该被 title 的 200 影响,它自己的推进照常
  s.handleMuxFrame(proj('s1', 'tokenUsage', { used: 1 }, 1))
  await s.open('s2')
  await s.open('s1')
  s.handleMuxFrame(proj('s1', 'tokenUsage', { used: 2 }, 2))
  const snapshot = s.getRuntimeSnapshot()
  assert.equal(snapshot.title, 'B')
  assert.deepEqual(snapshot.tokenUsage, { used: 2 },
    'tokenUsage 必须能继续推进,实际 ' + JSON.stringify(snapshot.tokenUsage))
})

test('baseline 里的块级 asOfSeq 仍被尊重(host 没给 seqs 时的兜底)', async () => {
  const s = service()
  await s.open('s1')
  s.handleMuxFrame({ type: 'item', streamId: 'control', value: {
    type: 'baseline',
    value: { queues: {}, jobs: {}, projections: { s1: { values: { title: 'FROM-BASELINE' }, asOfSeq: 7 } } }
  } })
  assert.equal(s.getRuntimeSnapshot().title, 'FROM-BASELINE')
  // 更旧的不该覆盖
  s.handleMuxFrame(proj('s1', 'title', 'STALE', 3))
  assert.equal(s.getRuntimeSnapshot().title, 'FROM-BASELINE', '块级 asOfSeq 仍要能挡住更旧的帧')
})
