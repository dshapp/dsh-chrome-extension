/**
 * DSH 0.2.0 协议适配:限时提问(attachWait 认领 / 倒计时 / ASK_TIMED_OUT / 慢慢回答)、
 * userQuestions 投影里 continued 问题的迟到回答与收起、question-reply 对话节点、
 * 会话搜索按原始标题、模型菜单的供应商排序与搜索、时长单元制、自动化任务触发卡。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test, mock } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'
import { createSessionStore } from '../src/features/sessions/session-store.js'
import { RPC, STREAM } from '../src/platform/dsh/rpc-methods.js'
import {
  questionWait, userQuestionsProjection, continuedQuestions, presentedQuestion,
  waitStatus, questionReplyContent, timedOutOutcome
} from '../src/features/interactions/timed-questions.js'
import { deriveSearchResults, sessionTitle } from '../src/features/sessions/session-search.js'
import {
  orderModelProviders, rankByName, modelMenuGroups, modelCount, MODEL_SEARCH_THRESHOLD
} from '../src/features/models/model-ranking.js'
import { turnTriggerDetails } from '../src/features/sessions/chat-nodes.js'
import { setLang, t } from '../src/shared/i18n.js'

const frame = (streamId, value) => ({ type: 'item', streamId, value })

function harness(respond = () => ({})) {
  const calls = []
  const subscriptions = []
  const unsubscribed = []
  const settled = []
  const connection = {
    subscribe(streamId, endpoint, args) { subscriptions.push({ streamId, endpoint, args }) },
    unsubscribe(streamId) { unsubscribed.push(streamId) },
    async settleRemoteEvent(clientId, eventId, outcome) { settled.push({ clientId, eventId, outcome }); return true },
    async call(method, args) {
      calls.push({ method, args })
      return respond(method, args)
    }
  }
  const service = createSessionService(connection)
  return { service, calls, subscriptions, unsubscribed, settled }
}

const QUESTIONS = [{ id: 'db', question: '用哪种数据库？', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }]

function askTimed(service, { eventId = 'e1', sessionId = 's1', callId = 'call_1', timed = true } = {}) {
  service.handleMuxFrame(frame('events', { type: 'ready', clientId: 'client-1' }))
  service.handleMuxFrame(frame('events', {
    type: 'waterfall', agentId: sessionId, eventId, event: 'user-questions/request',
    request: { questions: QUESTIONS, ...(callId ? { wait: { callId, ...(timed ? { timed: true } : {}) } } : {}) }
  }))
}

test('questionWait:缺省=阻塞;callId 无 timed=无限期卡片;timed:true 才认领', () => {
  assert.deepEqual(questionWait({ questions: [] }), { callId: null, timed: false })
  assert.deepEqual(questionWait({ wait: { callId: 'c' } }), { callId: 'c', timed: false })
  assert.deepEqual(questionWait({ wait: { callId: 'c', timed: true } }), { callId: 'c', timed: true })
  assert.deepEqual(questionWait({ wait: { timed: true } }), { callId: null, timed: false })
})

test('限时提问:先订阅 attachWait 认领,第一帧 remainingMs 起表,到点以 ASK_TIMED_OUT 结算并释放认领', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const { service, subscriptions, unsubscribed, settled } = harness()
  await service.open('s1')
  askTimed(service)
  const sub = subscriptions.find((s) => s.endpoint === STREAM.userQuestionsAttachWait)
  assert.deepEqual(sub, { streamId: 'question-wait:e1', endpoint: 'userQuestions/attachWait', args: { agentId: 's1', callId: 'call_1' } })

  let question = service.getRuntimeSnapshot().pendingQuestion
  assert.equal(question.callId, 'call_1')
  assert.equal(question.timed, true)
  assert.equal(question.deadline, null, '认领首帧到达前不倒数')

  service.handleMuxFrame(frame('question-wait:e1', { remainingMs: 25_000 }))
  question = service.getRuntimeSnapshot().pendingQuestion
  assert.equal(question.deadline, 1_025_000)
  assert.deepEqual(waitStatus(question, 1_000_000), { kind: 'countdown', seconds: 25 })

  t.mock.timers.tick(25_000)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(settled.length, 1)
  assert.deepEqual(settled[0], { clientId: 'client-1', eventId: 'e1', outcome: timedOutOutcome() })
  assert.equal(settled[0].outcome.error.code, 'ASK_TIMED_OUT')
  assert.deepEqual(Object.keys(settled[0].outcome.error).sort(), ['code', 'message', 'name'], '网关只收 name/message/code/details')
  assert.equal(service.getRuntimeSnapshot().pendingQuestion, null, '结算方收不到 cancel 帧,必须本地退场')
  assert.ok(unsubscribed.includes('question-wait:e1'))
})

test('慢慢回答 / 开始作答:停表并持有认领,到点也不超时;提交后才释放', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const { service, unsubscribed, settled } = harness()
  await service.open('s1')
  askTimed(service)
  service.handleMuxFrame(frame('question-wait:e1', { remainingMs: 10_000 }))
  service.holdQuestion('e1')
  const held = service.getRuntimeSnapshot().pendingQuestion
  assert.equal(held.held, true)
  assert.equal(held.deadline, null)
  assert.deepEqual(waitStatus(held), { kind: 'held' })
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(settled.length, 0, '持有期间不超时')
  assert.ok(!unsubscribed.includes('question-wait:e1'), '持有期间认领不能断')

  const receipt = await service.respondInteraction('e1', { ok: true, value: { answer: { answers: [{ id: 'db', selected: ['Postgres'] }] } } })
  assert.deepEqual(receipt, { accepted: true })
  assert.equal(settled[0].outcome.kind, 'result')
  assert.ok(unsubscribed.includes('question-wait:e1'), '结算之后释放认领')
})

test('持有之后迟到的认领首帧不会重新起表', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const { service, settled } = harness()
  await service.open('s1')
  askTimed(service)
  service.holdQuestion('e1')
  service.handleMuxFrame(frame('question-wait:e1', { remainingMs: 1_000 }))
  assert.equal(service.getRuntimeSnapshot().pendingQuestion.deadline, null)
  t.mock.timers.tick(5_000)
  await Promise.resolve()
  assert.equal(settled.length, 0)
})

test('阻塞式提问(无 wait)与无限期卡片(无 timed)不认领、不倒数,holdQuestion 不改它', async () => {
  const { service, subscriptions } = harness()
  await service.open('s1')
  askTimed(service, { callId: null })
  askTimed(service, { eventId: 'e2', callId: 'call_2', timed: false })
  assert.ok(!subscriptions.some((s) => s.endpoint === STREAM.userQuestionsAttachWait))
  service.holdQuestion('e2')
  assert.equal(service.getRuntimeSnapshot().pendingQuestion.held, false)
  assert.equal(waitStatus(service.getRuntimeSnapshot().pendingQuestion), null)
})

test('宿主 cancel(别处答掉)与重连都会释放认领与倒计时', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const { service, unsubscribed, settled } = harness()
  await service.open('s1')
  askTimed(service)
  service.handleMuxFrame(frame('question-wait:e1', { remainingMs: 5_000 }))
  service.handleMuxFrame(frame('events', { type: 'cancel', eventId: 'e1' }))
  assert.ok(unsubscribed.includes('question-wait:e1'))
  t.mock.timers.tick(10_000)
  await Promise.resolve()
  assert.equal(settled.length, 0, 'cancel 之后旧表不能再结算')

  askTimed(service, { eventId: 'e3', callId: 'call_3' })
  service.handleMuxFrame(frame('question-wait:e3', { remainingMs: 5_000 }))
  service.generationOpened()
  assert.ok(unsubscribed.includes('question-wait:e3'))
  t.mock.timers.tick(10_000)
  await Promise.resolve()
  assert.equal(settled.length, 0)
})

test('userQuestions 投影:continued 行成为可回答的提问;inbox 排着回复或本端已回答时不再出现', () => {
  const projection = userQuestionsProjection({
    active: [
      { callId: 'c-open', questions: QUESTIONS, state: 'open' },
      { callId: 'c1', questions: QUESTIONS, state: 'continued' },
      { callId: 'c2', questions: QUESTIONS, state: 'continued' }
    ],
    settled: [{ callId: 'c0', answers: [] }]
  })
  const queue = [{ message: { source: { kind: 'user-question-reply', callId: 'c2', outcome: 'answered' } } }]
  const continued = continuedQuestions({ sessionId: 's1', projection, queue, replied: new Set() })
  assert.deepEqual(continued.map((q) => q.callId), ['c1'])
  assert.equal(continued[0].continued, true)
  assert.equal(continued[0].eventId, null)
  assert.deepEqual(continuedQuestions({ sessionId: 's1', projection, queue: [], replied: new Set(['c1', 'c2']) }), [])
  // 实时 waterfall 优先;收起的 continued 不占席位
  assert.equal(presentedQuestion({ pending: { eventId: 'e' }, continued, hidden: new Set() }).eventId, 'e')
  assert.equal(presentedQuestion({ pending: null, continued, hidden: new Set(['c1']) }), null)
  assert.equal(presentedQuestion({ pending: null, continued, hidden: new Set() }).callId, 'c1')
  assert.deepEqual(waitStatus(continued[0]), { kind: 'continued' })
})

test('continued 提问:回答走 userQuestions/answer;关闭只收起不发请求,可重开;REPLY_QUEUED 视为已送达', async () => {
  const { service, calls } = harness((method) => (method === RPC.userQuestionsAnswer ? true : {}))
  await service.open('s1')
  service.store.applyProjection('userQuestions', { active: [{ callId: 'c1', questions: QUESTIONS, state: 'continued' }], settled: [] }, 10)
  let snap = service.getRuntimeSnapshot()
  assert.equal(snap.presentedQuestion.callId, 'c1')

  const hide = await service.respondContinuedQuestion(snap.presentedQuestion, { ok: false })
  assert.deepEqual(hide, { accepted: true })
  assert.equal(calls.filter((c) => c.method === RPC.userQuestionsAnswer).length, 0, '关闭面板什么都不发')
  snap = service.getRuntimeSnapshot()
  assert.equal(snap.presentedQuestion, null)
  assert.equal(snap.continuedQuestions.length, 1, '收起后仍可回答')

  service.reopenQuestion('s1', 'c1')
  snap = service.getRuntimeSnapshot()
  assert.equal(snap.presentedQuestion.callId, 'c1')

  const answers = [{ id: 'db', selected: ['Postgres'] }]
  const receipt = await service.respondContinuedQuestion(snap.presentedQuestion, { ok: true, value: { answer: { answers } } })
  assert.deepEqual(receipt, { accepted: true })
  assert.deepEqual(calls.find((c) => c.method === RPC.userQuestionsAnswer).args, { agentId: 's1', callId: 'c1', answer: { answers } })
  assert.equal(service.getRuntimeSnapshot().presentedQuestion, null, '回答后在 inbox 跟上之前也不再显示')

  // REPLY_QUEUED 与 false
  const queued = harness((method) => {
    if (method === RPC.userQuestionsAnswer) throw Object.assign(new Error('a reply is already queued'), { code: 'REPLY_QUEUED' })
    return {}
  })
  await queued.service.open('s1')
  assert.deepEqual(await queued.service.respondContinuedQuestion({ sessionId: 's1', callId: 'c9' }, { ok: true, value: { answer: { answers } } }), { accepted: true })
  const stale = harness((method) => (method === RPC.userQuestionsAnswer ? false : {}))
  await stale.service.open('s1')
  assert.deepEqual(await stale.service.respondContinuedQuestion({ sessionId: 's1', callId: 'c9' }, { ok: true, value: { answer: { answers } } }), { accepted: false })
})

test('question-reply:source=user-question-reply 的 user/message 总是成行,读出问答对', () => {
  const store = createSessionStore()
  store.reset('s1')
  const text = JSON.stringify({
    kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'c1',
    questions: [...QUESTIONS, { id: 'size', question: '规模？' }],
    answers: [{ id: 'db', selected: ['Postgres'], custom: '要支持 JSON' }, { id: 'size', selected: [] }]
  })
  store.applyEvent({ seq: 1, type: 'turn/start', data: { turn: 1 } })
  store.applyEvent({ seq: 2, type: 'user/message', time: 5, data: { id: 'm1', source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' }, content: [{ type: 'text', text }] } })
  const node = store.getSnapshot().nodes.find((n) => n.kind === 'turnTrigger')
  assert.ok(node, '没唤醒本轮也要显示')
  const reply = questionReplyContent(node.source, node.content)
  assert.equal(reply.callId, 'c1')
  assert.deepEqual(reply.pairs.map((p) => p.answers), [['Postgres', '要支持 JSON'], []])
  assert.equal(questionReplyContent({ kind: 'user-question-reply' }, [{ type: 'text', text: 'not json' }]), null)
  assert.equal(questionReplyContent({ kind: 'user' }, [{ type: 'text', text }]), null)
  assert.equal(turnTriggerDetails({ kind: 'user-question-reply' }).title, 'question.replyLabel')
})

test('会话搜索:标题只按会话自己的标题匹配(0.2 去掉 sessionId 兜底),无标题显示未命名', () => {
  const sessions = [
    { sessionId: 'session-abc123', updatedAt: 2, cwd: '/tmp/proj', projections: { values: {} } },
    { sessionId: 'session-def456', updatedAt: 1, cwd: '/tmp/other', projections: { values: { title: '  修复登录  ' } } }
  ]
  const search = (query) => deriveSearchResults({ sessions, workspaces: [], archivedIds: [], query, remote: { items: [], hasMore: false } }).items.map((i) => i.sessionId)
  assert.deepEqual(search('abc123'), [], 'sessionId 不再命中')
  assert.deepEqual(search('修复'), ['session-def456'])
  assert.deepEqual(search('proj'), ['session-abc123'], '目录名仍由工作区标签那一臂命中')
  assert.equal(sessionTitle(sessions[0]), '')
  assert.equal(sessionTitle(sessions[1]), '修复登录')
})

test('模型菜单:供应商 account → official → 其余目录顺序;超过 4 个模型才搜索;rankByName 前缀优先、空组隐藏', () => {
  const groups = [
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'opus', name: 'Claude Opus' }, { id: 'sonnet', name: 'Claude Sonnet' }] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'v4', name: 'DeepSeek-V4' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT-5' }] },
    { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'v4f', name: 'DeepSeek-V4-Flash' }] }
  ]
  assert.deepEqual(orderModelProviders(groups).map((g) => g.id), ['deepseek-account', 'deepseek-official', 'anthropic', 'openai'])
  assert.equal(modelCount(groups), 5)
  assert.ok(modelCount(groups) > MODEL_SEARCH_THRESHOLD)
  assert.deepEqual(modelMenuGroups(groups, 'son').map((g) => [g.id, g.models.map((m) => m.id)]), [['anthropic', ['sonnet']]])
  assert.deepEqual(modelMenuGroups(groups, 'son', { showSearch: false }).length, 4, '没有搜索框就不过滤')
  assert.deepEqual(modelMenuGroups(groups, 'dsv4').flatMap((g) => g.models.map((m) => m.id)), ['v4f', 'v4'])
  // 前缀命中排在非前缀之前;同分保持原顺序
  const items = [{ name: 'claude-sonnet' }, { name: 'sonnet' }, { name: 'xsonnet' }]
  assert.deepEqual(rankByName(items, 'son').map((i) => i.name), ['sonnet', 'claude-sonnet', 'xsonnet'])
  assert.equal(rankByName(items, ''), items)
  assert.deepEqual(rankByName(items, 'zzz'), [])
})

test('时长单元制(web formatRunDuration 0.2)与「自动化任务」触发卡', async () => {
  const { formatRunDuration } = await import('../src/features/chat/node-views.js')
  setLang('en')
  assert.equal(formatRunDuration(5_400), '5s')
  assert.equal(formatRunDuration(125_000), '2m 5s')
  assert.equal(formatRunDuration(3_603_000), '1h 0m 3s')
  assert.equal(t('message.trigger.schedule'), 'Automation task')
  setLang('zh')
  assert.equal(formatRunDuration(5_000), '5秒')
  assert.equal(formatRunDuration(125_000), '2分5秒')
  assert.equal(formatRunDuration(3_603_000), '1小时0分3秒')
  assert.equal(t('message.trigger.schedule'), '自动化任务')
  assert.equal(turnTriggerDetails({ kind: 'schedule' }).icon, 'clock')
})
