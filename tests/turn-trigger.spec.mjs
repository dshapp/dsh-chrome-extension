/**
 * dsh 0.1.7 对话区可见性:唤醒本轮的非人类消息显示为 turn-trigger 通知行,
 * 其余普通 context 注入与 permission 命令行不进聊天记录。
 *
 * 对齐 web ui-chat contract/chat-visibility.ts(isVisibleChatNode)、
 * conversation-nodes/message.ts(waking)、chat/turn-trigger.ts(turnTriggerDetails)、
 * chat/TurnTriggerNodeView.tsx,以及 Mac 267bcde 的 SessionStore.isWaking / TurnTriggerRow。
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

const { setLang } = await import('../src/shared/i18n.js')
setLang('en')
const { createSessionStore } = await import('../src/features/sessions/session-store.js')
const { NodeKind, turnTriggerDetails, turnTriggerNode } = await import('../src/features/sessions/chat-nodes.js')
const { isProcessMember, PROCESS_INDEPENDENT_KINDS } = await import('../src/features/sessions/turn-process.js')
const { createTurnTriggerNode } = await import('../src/features/chat/node-views.js')

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const splice = (seq, target, { start = 0, removedCount, inserted = [], outcome } = {}) => ({
  seq, time: seq, type: 'agent/inbox/spliced',
  data: { target, start, inserted, ...(removedCount == null ? {} : { removedCount }), ...(outcome ? { outcome } : {}) }
})
const entry = (id, kind) => ({ id, source: { kind }, content: [{ type: 'text', text: id }] })
const message = (seq, id, source, text = id) => ({
  seq, time: seq, type: 'user/message', surfaceOp: { op: 'append' },
  data: { message: { id, role: 'user', source, content: [{ type: 'text', text }] } }
})
// turn/start 会预置本轮的 turnTail 行,这里只看消息类行。
const messageNodes = (store) => store.getSnapshot().nodes.filter((node) => node.kind !== NodeKind.turnTail)
const kinds = (store) => messageNodes(store).map((node) => node.kind)

test('next-turn 认领的非人类消息成为 turn-trigger;同轮其余 context 不进记录', () => {
  const store = createSessionStore()
  store.applyEvent(splice(1, 'next-turn', { inserted: [entry('m-sub', 'subagent-settled')] }))
  store.applyEvent({ seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent(splice(3, 'next-turn', { removedCount: 1 }))
  store.applyEvent({ seq: 4, time: 4, type: 'step/start', data: { turn: 1, step: 1 } })
  store.applyEvent(message(5, 'm-sub', { kind: 'subagent-settled' }))
  store.applyEvent(message(6, 'm-inst', { kind: 'agent-instructions' }))
  store.applyEvent(message(7, 'm-cat', { kind: 'skill-catalog' }))
  const nodes = messageNodes(store)
  assert.deepEqual(nodes.map((n) => n.kind), [NodeKind.turnTrigger])
  assert.equal(nodes[0].messageId, 'm-sub')
  assert.deepEqual(nodes[0].source, { kind: 'subagent-settled' })
})

test('人类消息开启的轮次:注入的 context 全部隐藏,用户消息照常', () => {
  const store = createSessionStore()
  store.applyEvent(splice(1, 'next-turn', { inserted: [entry('u1', 'user')] }))
  store.applyEvent({ seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent(splice(3, 'next-turn', { removedCount: 1 }))
  store.applyEvent({ seq: 4, time: 4, type: 'step/start', data: { turn: 1, step: 1 } })
  store.applyEvent(message(5, 'u1', { kind: 'user' }))
  store.applyEvent(message(6, 'm-plugin', { kind: 'plugin' }))
  assert.deepEqual(kinds(store), [NodeKind.user])
})

test('idle steer:step 1 内、turn/start 之后的 next-step 认领(无人类)唤醒本轮', () => {
  const store = createSessionStore()
  store.applyEvent(splice(1, 'next-step', { inserted: [entry('g1', 'goal')] }))
  store.applyEvent({ seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent({ seq: 3, time: 3, type: 'step/start', data: { turn: 1, step: 1 } })
  store.applyEvent(splice(4, 'next-step', { removedCount: 1 }))
  store.applyEvent(message(5, 'g1', { kind: 'goal' }))
  assert.deepEqual(kinds(store), [NodeKind.turnTrigger])
})

test('idle steer 批次里有人类消息时,由人类消息开启本轮,通知不成行', () => {
  const store = createSessionStore()
  store.applyEvent(splice(1, 'next-step', { inserted: [entry('g1', 'goal'), entry('u1', 'user')] }))
  store.applyEvent({ seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent({ seq: 3, time: 3, type: 'step/start', data: { turn: 1, step: 1 } })
  store.applyEvent(splice(4, 'next-step', { removedCount: 2 }))
  store.applyEvent(message(5, 'g1', { kind: 'goal' }))
  store.applyEvent(message(6, 'u1', { kind: 'user' }))
  assert.deepEqual(kinds(store), [NodeKind.steering])
})

test('轮中(step > 1)next-step 认领的子代理回报不是唤醒,不进记录;取消的认领也不算', () => {
  const store = createSessionStore()
  store.applyEvent(splice(1, 'next-turn', { inserted: [entry('u1', 'user')] }))
  store.applyEvent({ seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent(splice(3, 'next-turn', { removedCount: 1 }))
  store.applyEvent({ seq: 4, time: 4, type: 'step/start', data: { turn: 1, step: 1 } })
  store.applyEvent(message(5, 'u1', { kind: 'user' }))
  store.applyEvent({ seq: 6, time: 6, type: 'step/start', data: { turn: 1, step: 2 } })
  store.applyEvent(splice(7, 'next-step', { inserted: [entry('s1', 'subagent-settled')] }))
  store.applyEvent(splice(8, 'next-step', { removedCount: 1 }))
  store.applyEvent(message(9, 's1', { kind: 'subagent-settled' }))
  store.applyEvent(splice(10, 'next-step', { inserted: [entry('s2', 'subagent-settled')] }))
  store.applyEvent(splice(11, 'next-step', { removedCount: 1, outcome: 'canceled' }))
  assert.deepEqual(kinds(store), [NodeKind.user])
})

test('permission 命令行不进聊天,其他命令照常', () => {
  const store = createSessionStore()
  store.applyEvent({ seq: 1, time: 1, type: 'command/run', data: { commandId: 'c1', name: 'permission', args: 'yolo', source: { kind: 'user' } } })
  store.applyEvent({ seq: 2, time: 2, type: 'command/run', data: { commandId: 'c2', name: 'plan', args: '', source: { kind: 'user' } } })
  const nodes = store.getSnapshot().nodes
  assert.deepEqual(nodes.map((n) => n.kind), [NodeKind.command])
  assert.equal(nodes[0].name, 'plan')
})

test('session-reference 召回不成行,但仍把引用标签回贴到其用户消息', () => {
  const store = createSessionStore()
  store.applyEvent(message(1, 'u1', { kind: 'user' }, 'see @alpha'))
  store.applyEvent(message(2, 'r1', {
    kind: 'session-reference',
    references: [{ label: 'alpha', sessionId: 'sess-a' }, { label: 'alpha', sessionId: 'sess-a' }]
  }))
  const nodes = store.getSnapshot().nodes
  assert.deepEqual(nodes.map((n) => n.kind), [NodeKind.user])
  assert.deepEqual(nodes[0].referenceLabels, ['alpha'])
  assert.deepEqual(nodes[0].referenceSessions, [{ label: 'alpha', sessionId: 'sess-a' }])
})

test('turn-trigger 与 user/steering 同级:不被折进过程组', () => {
  assert.ok(PROCESS_INDEPENDENT_KINDS.has(NodeKind.turnTrigger))
  assert.ok(!PROCESS_INDEPENDENT_KINDS.has('context'))
  const node = turnTriggerNode({ seq: 5, time: 5, messageId: 'm', content: [], source: { kind: 'goal' } })
  node.turn = 1 // 即使带了 turn 也不会成为成员
  assert.equal(isProcessMember(node, { turn: 1, processStartSeq: 0, answerAnchorSeq: 100 }), false)
})

test('turnTriggerDetails:按 source.kind 选标题与图标,github webhook 单独', () => {
  const title = (source) => turnTriggerDetails(source).title
  assert.equal(title({ kind: 'goal' }), 'message.trigger.goal')
  assert.equal(title({ kind: 'agent-message' }), 'message.trigger.agent')
  assert.equal(title({ kind: 'team-message' }), 'message.trigger.team')
  assert.equal(title({ kind: 'subagent-settled' }), 'message.trigger.subagent')
  assert.equal(title({ kind: 'webhook', provider: 'github' }), 'message.trigger.github')
  assert.equal(title({ kind: 'webhook', provider: 'linear' }), 'message.trigger.webhook')
  assert.equal(title({ kind: 'schedule' }), 'message.trigger.schedule')
  assert.equal(title({ kind: 'tool-jobs' }), 'message.trigger.job')
  assert.equal(title({ kind: 'cordis-host-runner' }), 'message.trigger.plugin')
  assert.equal(title({ kind: 'plugin:custom' }), 'message.trigger.request')
  assert.equal(title(null), 'message.trigger.request')
  assert.notEqual(turnTriggerDetails({ kind: 'webhook', provider: 'github' }).icon,
    turnTriggerDetails({ kind: 'webhook' }).icon)
})

function imageBlock(attachmentId) {
  return { type: 'image', attachment: { attachmentId, mediaType: 'image/png', name: 'shot.png' } }
}

function renderTrigger(content, reads = []) {
  return createTurnTriggerNode(
    turnTriggerNode({ seq: 1, time: Date.now(), messageId: 'm', content, source: { kind: 'tool-jobs' } }),
    {
      readAttachment: async (id) => {
        reads.push(id)
        return { data: 'QUJD', attachment: { mediaType: 'image/png' } } // "ABC"
      }
    }
  )
}

test('通知行默认收起:只有标题行,正文与图片在首次展开时才构建', async () => {
  const reads = []
  const row = renderTrigger([{ type: 'text', text: 'job 42 finished' }, imageBlock('att-1')], reads)
  const header = row.querySelector('.turn-trigger-header')
  assert.equal(row.querySelector('.turn-trigger-title').textContent, 'Background task updated')
  assert.equal(header.getAttribute('aria-expanded'), 'false')
  assert.equal(row.querySelector('.turn-trigger-body'), null, '收起时不挂正文')
  assert.deepEqual(reads, [], '收起时不读附件')

  header.click()
  await flush()
  assert.equal(header.getAttribute('aria-expanded'), 'true')
  const body = row.querySelector('.turn-trigger-body')
  assert.equal(body.hidden, false)
  assert.equal(row.querySelector('.turn-trigger-explanation').textContent, 'This notification triggered this response.')
  assert.equal(row.querySelector('.context-body').textContent, 'job 42 finished')
  const images = row.querySelectorAll('img')
  assert.equal(images.length, 1)
  assert.equal(images[0].src, 'data:image/png;base64,QUJD')
  assert.deepEqual(reads, ['att-1'])

  header.click()
  assert.equal(body.hidden, true, '再次点击收起')
  header.click()
  assert.equal(row.querySelectorAll('.turn-trigger-body').length, 1, '重复展开复用同一份正文')
})

test('纯图片通知:正文不出现 [image] 占位符,多图走缩略图网格', async () => {
  const row = renderTrigger([imageBlock('a'), imageBlock('b')])
  row.querySelector('.turn-trigger-header').click()
  await flush()
  assert.equal(row.querySelector('.context-body'), null)
  assert.equal(row.querySelectorAll('img').length, 2)
  assert.ok(row.querySelector('.context-imgs').classList.contains('multi'))
  assert.ok(!row.textContent.includes('[image]'))
})
