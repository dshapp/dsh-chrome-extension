import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createSessionStore } from '../src/features/sessions/session-store.js'
import { createSessionService } from '../src/features/sessions/session-service.js'
import { toolRowModel, preparingArguments } from '../src/features/chat/tool-row-model.js'
import { createChatRenderer } from '../src/features/chat/chat-renderer.js'
import { createToolNode } from '../src/features/chat/node-views.js'
import { assembleTrajectory } from '../src/features/trajectory/trajectory-model.js'
import { recordStatus } from '../src/features/trajectory/trajectory-detail.js'
import { setLang } from '../src/shared/i18n.js'
import { RPC } from '../src/platform/dsh/rpc-methods.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement })
setLang('en')
const event = (seq, type, data, time = seq * 1000) => ({ seq, type, data, time })
const text = value => [{ type: 'text', text: value }]
const call = (seq, id = 'c', name = 'read') => event(seq, 'tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{"file_path":"file.txt"}' })
const start = store => store.applyEvent(event(0, 'turn/start', { turn: 1 }))
const assistant = (seq, step, content) => ({ ...event(seq, 'assistant/message', { turn: 1, step, message: { id: 'a' + step, role: 'assistant', content } }), surfaceOp: 'append' })
const end = (seq, kind = 'completed') => event(seq, 'turn/end', { turn: 1, reason: { kind } })
const stream = (store, chunk, time = 1000) => store.applyAssistantStreamFrame({ type: 'chunk', attemptId: 'attempt', chunk, time })
function runningStream() {
  const store = createSessionStore(); store.reset('s'); store.setCwd('/project'); start(store)
  store.applyAssistantStreamFrame({ type: 'start', attemptId: 'attempt', turn: 1, step: 1, startedAfterSeq: 0 })
  stream(store, { type: 'block-start', index: 0, blockType: 'tool-call' })
  return store
}

 test('effective directory projection/events preserve original cwd and reject stale projections', () => {
  const store = createSessionStore(); store.reset('s'); store.setCwd('/project')
  store.applyProjection('workingDirectory', '/worktree', 4)
  assert.equal(store.getSnapshot().cwd, '/project')
  assert.equal(store.getSnapshot().currentDirectory, '/worktree')
  store.applyProjection('workingDirectory', '/stale', 3)
  assert.equal(store.getSnapshot().workingDirectory, '/worktree')
  store.applyEvent(event(5, 'working-directory/change', { cwd: '/next' }))
  assert.equal(store.getSnapshot().currentDirectory, '/next')
  assert.equal(store.getSnapshot().nodes.length, 0)
  store.applyProjection('workingDirectory', null, 6)
  assert.equal(store.getSnapshot().currentDirectory, '/project')
})

test('historical relative root links retain operation directory through replay', () => {
  const store = createSessionStore(); store.reset('s'); store.setCwd('/project'); start(store)
  store.applyEvent(call(1)); store.applyEvent(event(2, 'tool/result', { callId: 'c', content: text('read') }))
  store.applyEvent(event(3, 'working-directory/change', { cwd: '/next' }))
  store.applyEvent(call(4, 'later'))
  store.applyEvent(event(2, 'tool/result', { callId: 'c', content: text('updated') }))
  assert.equal(store.toolCall('c').cwd, '/project')
  assert.equal(store.toolCall('later').cwd, '/next')
  assert.equal(store.getSnapshot().currentDirectory, '/next')
  const opened = []
  const row = createToolNode(store.toolCall('c'), { cwd: '/next', onOpenPath: path => opened.push(path) })
  row.querySelector('.tool-path').click()
  assert.deepEqual(opened, ['/project/file.txt'])
})

test('PTC nested meta/error round trip; metadata controls historical navigation', () => {
  const store = createSessionStore(); store.reset('s'); start(store); store.applyEvent(call(1, 'root', 'run_code'))
  const base = { subCallId: 'nested', rootCallId: 'root', parentCallId: 'root', name: 'read', arguments: { file_path: 'file.txt' } }
  store.applyEvent(event(2, 'tool/ptc-dispatch-start', base))
  const meta = { path: '/old/file.txt', lines: [1, 2] }; const error = { name: 'Denied', code: 'DENIED', reason: 'Raw failure reason' }
  store.applyEvent(event(3, 'tool/ptc-dispatch', { ...base, content: [], isError: true, meta, error }))
  const child = store.getSnapshot().nodes.find(n => n.callId === 'root').subCalls[0]
  assert.deepEqual(child.result.meta, meta); assert.deepEqual(child.result.error, error)
  assert.equal(toolRowModel(child, { cwd: '/new' }).filePath, '/old/file.txt')
  assert.equal(toolRowModel(child).output, error.reason)
  const without = { ...child, result: { ...child.result, meta: null, isError: false } }
  assert.equal(toolRowModel(without).filePath, null, 'no guessed relative navigation for metadata-less nested call')
})

test('file navigation guards running/failed relative paths while preserving absolute ones', () => {
  const node = { name: 'read', argsRaw: '{"file_path":"relative.txt"}', result: null }
  assert.equal(toolRowModel(node).filePath, null)
  assert.equal(toolRowModel({ ...node, result: { content: [], isError: true } }).filePath, null)
  assert.equal(toolRowModel({ ...node, result: { content: [], isError: false } }).filePath, 'relative.txt')
  assert.equal(toolRowModel({ ...node, argsRaw: '{"file_path":"/absolute.txt"}' }).filePath, '/absolute.txt')
})

test('streamed tool slot retains id from delta and hands off exactly once', () => {
  const store = runningStream()
  stream(store, { type: 'tool-call-delta', index: 0, id: 'c', name: 'write', argumentsDelta: '{"file_path":"out.txt","content":"abc' })
  const preparing = store.getSnapshot().nodes.filter(n => n.kind === 'toolCall')
  assert.equal(preparing.length, 1); assert.equal(preparing[0].preparing, true)
  assert.equal(toolRowModel(preparing[0]).state, 'preparing')
  const row = createToolNode(preparing[0], { onOpenPath() { throw Error('must not navigate') } })
  assert.equal(row.querySelector('.tool-path'), null)
  assert.equal(row.querySelector('.tool-header').getAttribute('aria-disabled'), 'true')
  store.applyEvent(call(1, 'c', 'write'))
  const calls = store.getSnapshot().nodes.filter(n => n.kind === 'toolCall')
  assert.equal(calls.length, 1); assert.equal(calls[0].preparing, undefined)
  assert.equal(calls[0].callId, preparing[0].callId)
})

test('cancelled preparation never invents a dispatched tool and turn closes cleanly', () => {
  const store = runningStream()
  stream(store, { type: 'tool-call-delta', index: 0, id: 'c', name: 'write', argumentsDelta: '{"file_path":"out.txt"' })
  assert.equal(store.getSnapshot().nodes.filter(n => n.preparing).length, 1)
  store.applyEvent(event(1, 'assistant/attempt', { turn: 1, step: 1 }))
  store.applyEvent(end(2, 'aborted'))
  assert.equal(store.getSnapshot().nodes.filter(n => n.kind === 'toolCall').length, 0)
  assert.equal(store.getSnapshot().runningTool, null)
  assert.equal(store.getSnapshot().running, false)
})

test('preparing argument summary is bounded, decodes escapes, and size reports UTF16 KB', () => {
  assert.deepEqual(preparingArguments("write", String.raw`{"file_path":"a\\b.txt","content":"` + "x".repeat(2048)), { summary: String.raw`a\b.txt`, filePath: String.raw`a\b.txt`, kilobytes: 3 })
  assert.equal(preparingArguments('read', '{"file_path":"not closed').summary, '')
  assert.equal(preparingArguments("run_code", String.raw`{"description":"Checking\nmore`).summary, "Checking")
  assert.equal(preparingArguments('write', '{"file_path":"a","content":"' + 'x'.repeat(1000000)).kilobytes, 977)
  const model = toolRowModel({ name: 'edit', argsRaw: JSON.stringify({ file_path: 'a', old_string: 'x'.repeat(1024), new_string: '😀' }), result: { content: [] } })
  assert.match(model.summarySuffix, /2/)
})

test('completed process keeps answer external and collapses its final reasoning, toggling restores it', () => {
  const store = createSessionStore(); store.reset('s'); start(store)
  store.applyEvent(assistant(1, 1, [{ type: 'reasoning', text: 'Final private reasoning' }, ...text('Final answer')]))
  store.applyEvent(end(2)); store.setHasMore(true)
  const snapshot = store.getSnapshot(); const spec = snapshot.turnProcessByTurn.get(1)
  assert.equal(spec.inlineReasoning, true); assert.equal(spec.durationMs, 2000)
  const container = document.createElement('div'); const renderer = createChatRenderer(container)
  renderer.render(snapshot.nodes)
  assert.equal(container.querySelector('.msg-turn').hidden, false)
  assert.equal(container.querySelector('.thinking-bubble').hidden, true)
  assert.match(container.querySelector('.msg-agent').textContent, /Final answer/)
  const control = container.querySelector('.turn-process'); assert.ok(control)
  control.click(); assert.equal(container.querySelector('.thinking-bubble').hidden, false)
  control.click(); assert.equal(container.querySelector('.thinking-bubble').hidden, true)
})

test('open partial turn has no process disclosure; closed without final reply cannot fold evidence', () => {
  const store = createSessionStore(); store.reset('s'); start(store); store.setHasMore(true)
  store.applyEvent(call(1))
  assert.equal(store.getSnapshot().turnProcessByTurn.size, 0)
  store.applyEvent(end(2))
  const spec = store.getSnapshot().turnProcessByTurn.get(1)
  assert.equal(spec.answerAnchorSeq, null); assert.equal(spec.inlineReasoning, false)
  const container = document.createElement('div'); createChatRenderer(container).render(store.getSnapshot().nodes)
  assert.equal(container.querySelector('.tool-row').hidden, false)
  assert.equal(container.querySelector('.turn-process').tagName, 'DIV')
})

test('stopped/failed process outcomes have no disclosure and no successful duration', () => {
  for (const [kind, outcome] of [['aborted', 'stopped'], ['error', 'failed']]) {
    const store = createSessionStore(); store.reset('s'); start(store)
    store.applyEvent(assistant(1, 1, text('Partial answer'))); store.applyEvent(end(2, kind))
    const spec = store.getSnapshot().turnProcessByTurn.get(1)
    assert.equal(spec.outcome, outcome); assert.equal(spec.answerAnchorSeq, null); assert.equal(spec.durationMs, null)
  }
})

test('trajectory preserves standalone and paired PTC settlement meta/error and complete status', () => {
  const data = { subCallId: 'nested', parentCallId: 'root', rootCallId: 'root', name: 'read', arguments: { file_path: 'a' }, content: text('read'), isError: false, meta: { path: '/old/a' } }
  for (const paired of [false, true]) {
    const events = [event(0, 'turn/start', { turn: 1 }), ...(paired ? [event(1, 'tool/ptc-dispatch-start', data)] : []), event(2, 'tool/ptc-dispatch', data)]
    const record = assembleTrajectory(events.map(event => ({ event }))).records.find(n => n.callId === 'nested')
    assert.deepEqual(record.meta, data.meta); assert.equal(record.outputDetail, 'read'); assert.equal(recordStatus(record), 'complete')
  }
})

function harness(respond = () => ({})) {
  const calls = []; const connection = { subscribe() {}, unsubscribe() {}, async call(method, args) { calls.push({ method, args }); return respond(method, args) } }
  return { service: createSessionService(connection), calls }
}
const mux = (service, streamId, value) => service.handleMuxFrame({ type: 'item', streamId, value })
test('goal activation exact identity survives late durable projection; stale get cannot override emit', async () => {
  let resolve; const { service } = harness(method => method === 'goals/get' ? new Promise(r => { resolve = r }) : {})
  await service.open('s')
  service.store.applyProjection('goal', { goal: { id: 'g', revision: 1, phase: 'active', activation: 'armed' } }, 1)
  const pending = service.refreshGoalActivation('s')
  mux(service, 'events', { type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's', goal: { id: 'g', revision: 1, activation: 'disarmed' } }] })
  resolve({ goal: { id: 'g', revision: 1, activation: 'armed' } }); await pending
  assert.equal(service.getRuntimeSnapshot().goal.activation, 'disarmed')
  service.store.applyProjection('goal', { goal: { id: 'g', revision: 1, phase: 'active', activation: 'armed' } }, 2)
  assert.equal(service.getRuntimeSnapshot().goal.activation, 'disarmed')
  service.store.applyProjection('goal', { goal: { id: 'other', revision: 1, phase: 'active', activation: 'armed' } }, 3)
  assert.equal(service.getRuntimeSnapshot().goal.activation, 'armed', 'no activation leak across goal identity')
  service.generationOpened()
  assert.equal(service.getRuntimeSnapshot().goal.activation, null)
})

test('multiple preparing slots keep stream order and reuse DOM across dispatch', () => {
  const store = runningStream()
  stream(store, { type: 'tool-call-delta', index: 0, id: 'z', name: 'read', argumentsDelta: '{"file_path":"z"}' })
  stream(store, { type: 'block-start', index: 1, blockType: 'tool-call' })
  stream(store, { type: 'tool-call-delta', index: 1, id: 'a', name: 'read', argumentsDelta: '{"file_path":"a"}' })
  const calls = store.getSnapshot().nodes.filter(n => n.kind === 'toolCall')
  assert.deepEqual(calls.map(n => n.callId), ['z', 'a'])
  const container = document.createElement('div'); const renderer = createChatRenderer(container)
  renderer.render(store.getSnapshot().nodes)
  const row = container.querySelector('.tool-row')
  assert.equal(row.querySelector('[role=button]'), null, 'preparing rows have no interactive disclosure')
  store.applyEvent(call(1, 'z'))
  renderer.render(store.getSnapshot().nodes)
  assert.equal(container.querySelector('[data-node-id="t-z"]'), row)
  assert.equal(container.querySelectorAll('[data-node-id="t-z"]').length, 1)
})

test('reconnect invalidates in-flight goal activation observations', async () => {
  let resolve; const { service } = harness(method => method === 'goals/get' ? new Promise(r => { resolve = r }) : {})
  await service.open('s')
  const pending = service.refreshGoalActivation('s')
  service.generationOpened()
  resolve({ goal: { id: 'g', revision: 1, activation: 'armed' } }); await pending
  assert.equal(service.getRuntimeSnapshot().goalActivation, null)
})

test('subagent earlier and jump pages retain the task-scoped address', async () => {
  const address = { kind: 'subagent', parentSessionId: 'p', childSessionId: 'child' }
  let earliest = 8
  const entry = seq => ({ event: event(seq, 'user/message', { role: 'user', content: text('hello') }) })
  const { service, calls } = harness(() => { earliest -= 4; return { records: [entry(earliest)], hasMore: earliest > 0 } })
  await service.loadSubagentHistory({ parentSessionId: 'p', childSessionId: 'child' })
  mux(service, 'follow:child', { type: 'snapshot', cursor: 8, records: [entry(8)], hasMore: true })
  await service.loadEarlier('child'); await service.loadThrough('child', 1)
  const pages = calls.filter(c => c.method === RPC.sessionPage)
  assert.equal(pages.length, 2)
  for (const page of pages) assert.deepEqual(page.args.request.address, address)
})
