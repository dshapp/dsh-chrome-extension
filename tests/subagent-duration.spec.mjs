/**
 * 运行中子代理的"已跑多久"必须随 wall clock 前进。
 *
 * 宿主 subagentTiming 投影的语义(dsh-subagent/lib/index.js):
 *  - active 存在 = 这一轮还开着;每个事件都把 active.through 推到 event.time;
 *  - turn/end 时把 active 折进 settledMs 并**删掉 active**。
 * 所以 active 还在就意味着 running,末刻要取 now;through 只是"最后一个事件的
 * 时刻",长工具调用/长思考期间事件是稀疏的,拿它当末刻会让时长一直冻住。
 *
 * popover 里那个 1 秒定时重绘(subagent-catalog-view 的 armliveRefresh)存在的
 * 唯一目的就是推进这个数字 —— 而它推不动,因为 now 参数永远被 through 挡掉。
 *
 * Mac 参考 SubagentCatalogAction.swift:511-521:
 *   end = activity == .running ? now : (active.through ?? since)
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { subagentDurationMs } from '../src/features/subagents/subagent-catalog.js'

/// 宿主投影形状:{ projections: { values: { subagentTiming } } }。
function summaryWith(timing) {
  return { projections: { values: { subagentTiming: timing } } }
}

test('运行中的子代理用时长的 wall clock,而不是最后一个事件的时刻', () => {
  const summary = summaryWith({ settledMs: 0, active: { since: 100_000, through: 100_500 } })
  const duration = subagentDurationMs(summary, 130_000, 'running')
  assert.equal(duration, 30_000,
    '运行中应当报 now - since(30000),实际 ' + duration + ' —— now 被子代理的 through 挡掉了')
})

test('运行中累计 settledMs 也计入', () => {
  const summary = summaryWith({ settledMs: 5_000, active: { since: 100_000, through: 100_500 } })
  assert.equal(subagentDurationMs(summary, 130_000, 'running'), 35_000)
})

test('存活的运行行:未传 running 时按 active 存在推断(宿主只在开区间保留 active)', () => {
  const summary = summaryWith({ settledMs: 0, active: { since: 100_000, through: 100_500 } })
  assert.equal(subagentDurationMs(summary, 130_000), 30_000)
})

test('结算后的行只报 settledMs(active 已被 turn/end 删除)', () => {
  const summary = summaryWith({ settledMs: 42_000 })
  assert.equal(subagentDurationMs(summary, 130_000, false), 42_000)
})

test('没有任何计时信息时返回 null', () => {
  assert.equal(subagentDurationMs(summaryWith(undefined), 130_000, 'running'), null)
  assert.equal(subagentDurationMs({}, 130_000, 'running'), null)
})

test('now 不可用(0/NaN)时退回 through,不倒退成 0', () => {
  const summary = summaryWith({ settledMs: 0, active: { since: 100_000, through: 100_500 } })
  assert.equal(subagentDurationMs(summary, 0, 'running'), 500)
  assert.equal(subagentDurationMs(summary, Number.NaN, 'running'), 500)
  // 时钟回拨:now 早于 through,取 through,时长不倒退。
  assert.equal(subagentDurationMs(summary, 90_000, 'running'), 500)
})
