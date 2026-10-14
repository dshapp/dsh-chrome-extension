/**
 * Turn process 折叠与 Mac 对齐(SessionStore.rebuildTurnProcessSpecs / isFoldedProcessRow):
 * - 成员按 anchor 区间判定:命令、压缩、turn 号指向窗口外更早一轮的孤儿结果,都随区间折叠;
 * - 已加载窗口还能向前增长(hasMore)时不折叠;
 * - 命令行只画结算文本(不回显 "/name",不单列 success)。
 *
 * 复现场景:会话窗口从 turn 2 中段开始(command/run 在窗口外,只剩 command/done),
 * turn 1 某调用的 prune 替换结果落在窗口内 → orphan-result;turn 2 中途压缩。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element

const { setLang } = await import('../src/shared/i18n.js')
setLang('en')
const { createSessionStore } = await import('../src/features/sessions/session-store.js')
const { NodeKind } = await import('../src/features/sessions/chat-nodes.js')
const { processSpecFor } = await import('../src/features/sessions/turn-process.js')
const { createCommandNode, createCompactionNode } = await import('../src/features/chat/node-views.js')

const text = (value) => [{ type: 'text', text: value }]

function replayPartialWindow(store) {
  const events = [
    // command/run(seq 33)在窗口外。
    { seq: 37, type: 'turn/start', data: { turn: 2 } },
    { seq: 38, type: 'user/message', surfaceOp: 'append',
      data: { message: { id: 'u2', role: 'user', source: { kind: 'user' }, content: text('align tokens') } } },
    { seq: 39, type: 'command/done', data: { commandId: 'cmd-1', kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } },
    { seq: 40, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 41, type: 'assistant/message', surfaceOp: 'append',
      data: { turn: 2, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'grep', arguments: '{}' }] } } },
    { seq: 42, type: 'tool/call', data: { turn: 2, step: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"x"}' } },
    { seq: 43, type: 'tool/result', surfaceOp: 'append',
      data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('found') } } },
    { seq: 44, type: 'step/end', data: { turn: 2, step: 1 } },
    // turn 1 的调用 c0 在窗口外;prune 替换它的结果 → 孤儿。
    { seq: 50, type: 'compaction/prune', data: { shadowedRange: { start: 26, end: 26 }, shadowedSeqs: [26] } },
    { seq: 51, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 26, endSeq: 26 },
      data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c0', content: text('[pruned]') } } },
    { seq: 60, type: 'compaction/start', data: { compactionId: 'k1', turn: 2 } },
    { seq: 61, type: 'compaction/summary', data: { compactionId: 'k1', summary: text('## Primary Request\nmore'), shadowedTokenCount: 36173 } },
    { seq: 62, type: 'compaction/end', data: { compactionId: 'k1', turn: 2 } },
    { seq: 70, type: 'step/start', data: { turn: 2, step: 2 } },
    { seq: 71, type: 'assistant/message', surfaceOp: 'append',
      data: { turn: 2, step: 2, message: { id: 'a2', role: 'assistant', content: text('Done.') } } },
    { seq: 72, type: 'step/end', data: { turn: 2, step: 2 } },
    { seq: 73, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }
  ]
  for (const event of events) store.applyEvent({ time: event.seq, ...event })
}

const byKind = (nodes, kind) => nodes.filter((node) => node.kind === kind)

test('完整窗口:命令、孤儿结果、压缩都落进本轮过程区间,随折叠头收起', () => {
  const store = createSessionStore()
  store.reset('s')
  replayPartialWindow(store)
  store.setHasMore(false)
  const { nodes, turnProcessByTurn } = store.getSnapshot()
  const spec = turnProcessByTurn.get(2)
  assert.ok(spec, 'turn 2 应该有折叠规格')
  // 计数只数模型做的事:孤儿结果的 turn 号是 1,不计入 turn 2。
  assert.equal(spec.toolCallCount, 1)

  const [command] = byKind(nodes, NodeKind.command)
  const [compaction] = byKind(nodes, NodeKind.compaction)
  const orphan = byKind(nodes, NodeKind.toolCall).find((node) => node.name === 'orphan-result')
  assert.ok(orphan)
  for (const node of [command, compaction, orphan]) {
    assert.equal(processSpecFor(node, turnProcessByTurn)?.turn, 2, `${node.kind} 应折进 turn 2`)
  }
  // 用户消息、回答、页脚留在组外。
  for (const node of nodes) {
    if (node.kind === NodeKind.user || node.kind === NodeKind.turnTail || node.kind === NodeKind.turnProcess) {
      assert.equal(processSpecFor(node, turnProcessByTurn), null)
    }
  }
  const answer = nodes.find((node) => node.kind === NodeKind.assistant && node.step === 2)
  assert.equal(processSpecFor(answer, turnProcessByTurn), null)
  // 折叠头紧贴在它折叠的首行之前。
  const control = byKind(nodes, NodeKind.turnProcess)[0]
  assert.equal(nodes[nodes.indexOf(control) + 1], command)
})

test('0.2.1 已关闭的局部窗口即使 hasMore 也从已加载起点折叠', () => {
  const store = createSessionStore()
  store.reset('s')
  replayPartialWindow(store)
  store.setHasMore(true)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.hasMore, true)
  assert.equal(snapshot.turnProcessByTurn.size, 1)
  assert.equal(byKind(snapshot.nodes, NodeKind.turnProcess).length, 1)
  const spec = snapshot.turnProcessByTurn.get(2)
  assert.equal(spec.processStartSeq, 39, "仅收起实际已加载的过程")
  assert.equal(spec.answerStep, 2)
  // 加载完更早历史仍保留折叠。
  store.setHasMore(false)
  assert.equal(store.getSnapshot().turnProcessByTurn.size, 1)
})

test('命令行只画结算文本:不回显 /name,不单列 success', () => {
  const row = createCommandNode({ kind: NodeKind.command, commandId: 'c', seq: 1, name: null, args: null,
    outcome: { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } })
  assert.equal(row.textContent, 'Plan mode on. Use /plan off to leave.')
  assert.ok(!row.textContent.includes('/?'))
  const silent = createCommandNode({ kind: NodeKind.command, commandId: 'c', seq: 1, name: 'plan', args: '',
    outcome: { kind: 'success', text: null } })
  assert.equal(silent.textContent, '')
  const failed = createCommandNode({ kind: NodeKind.command, commandId: 'c', seq: 1, name: 'x', args: '',
    outcome: { kind: 'error', text: null } })
  assert.equal(failed.textContent, 'Failed')
  assert.ok(failed.classList.contains('error'))
  const goal = createCommandNode({ kind: NodeKind.command, commandId: 'c', seq: 1, name: 'goal', args: ' ship it  ',
    outcome: { kind: 'success', text: 'Goal set.' } })
  assert.equal(goal.querySelector('.command-input-bubble').textContent, '/goal ship it')
})

test('压缩行摘要位:项数+token → 摘要首行 → 不可用', () => {
  const base = { kind: NodeKind.compaction, compactionId: 'k', seq: 1 }
  assert.equal(createCompactionNode({ ...base, summary: 's', shadowedItemCount: 3, shadowedTokenCount: 10 }).textContent,
    'Compacted 3 items · 10 tokens')
  const summary = createCompactionNode({ ...base, summary: 'first line\nsecond', shadowedTokenCount: 10 })
  assert.equal(summary.textContent, 'first line')
  assert.ok(summary.querySelector('button.chip-head'))
  const missing = createCompactionNode({ ...base, summary: null })
  assert.equal(missing.textContent, 'Compaction summary unavailable')
  assert.equal(missing.querySelector('button'), null)
})
