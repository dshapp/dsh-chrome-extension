/**
 * 轨迹记录的 id 必须唯一。
 *
 * assembleTrajectory 用 (turn, step) 作为助手行的身份:assistantRecordIndex 就是
 * "这个 step 已经有助手行了"的台账,工具行/请求行也按 records 下标回指。
 * 但 step/end 在请求没有结算时补的那条 requestOnly 占位行**没有登记**到
 * assistantRecordIndex,于是同一 step 稍后再来一条 assistant/message 时,
 * 代码只看见"下标里没有",又 push 了第二条 —— 两条记录的 id 完全相同。
 *
 * id 是上层逻辑的主键:trajectory-view 用它做折叠集合(collapsedAssistants),
 * 选中态 selectedRecordId 也靠它比对,时间线一槽一个 span。重复 id 会让
 * 两行一起折叠/一起高亮,时间线上同一个 step 出现两个槽位。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assembleTrajectory } from '../src/features/trajectory/trajectory-model.js'

/** 把裸事件数组补上 seq/time 再折成轨迹。 */
function assemble(events) {
  return assembleTrajectory(events.map((event, index) => ({
    seq: index + 1,
    event: { seq: index + 1, time: 1000 + index, ...event }
  })))
}

/** 第一个重复出现的 id,没有则返回 null。 */
function firstDuplicateId(records) {
  const seen = new Set()
  for (const record of records) {
    if (seen.has(record.id)) return record.id
    seen.add(record.id)
  }
  return null
}

test('每个记录的 id 唯一(step/end 之后同一 step 又来 assistant/message)', () => {
  const { records } = assemble([
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    // 请求在没有助手消息的情况下结束 → 补一条 requestOnly 占位行。
    { type: 'step/end', data: { turn: 0, step: 0 } },
    // 同一 step 的助手消息迟到(重放窗口/中断收尾)。
    { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'late' }] } } }
  ])
  const duplicate = firstDuplicateId(records)
  assert.equal(duplicate, null,
    `记录 id 重复:${JSON.stringify(duplicate)} —— ids=${records.map((r) => r.id).join(' , ')}`)
})

test('同一 step 的助手消息只会留下一行', () => {
  const { records } = assemble([
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'first' }] } } },
    { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'second' }] } } }
  ])
  const assistants = records.filter((record) => record.kind === 'assistant')
  assert.equal(assistants.length, 1,
    `同一个 (turn, step) 只该有一条助手行,实际 ${assistants.length} 条:${assistants.map((r) => r.text).join(' | ')}`)
  assert.equal(assistants[0].text, 'second', '迟到的那次应当就地结算原有的行')
})

test('正常顺序(assistant/message 在 step/end 之前)不受影响', () => {
  const { records } = assemble([
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'step/end', data: { turn: 0, step: 0 } }
  ])
  const assistants = records.filter((record) => record.kind === 'assistant')
  assert.equal(assistants.length, 1, records.map((r) => r.id + ':' + r.text).join(' | '))
  assert.equal(assistants[0].text, 'done')
  assert.equal(firstDuplicateId(records), null)
})
