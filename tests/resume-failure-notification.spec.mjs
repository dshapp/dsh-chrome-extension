/**
 * "后台任务失败:resume failed for session ..." 这条幽灵通知的闸门。
 *
 * 复现链(已在本机宿主上实测):
 *   某个旧会话的 header 钉着 agentPreset: "ptc-zh",而这个 preset 早被删了
 *   → 任何客户端对它开 session/follow,宿主 SessionHistoryController 拿到冷
 *     快照后会后台 promote() 激活它(index.js:1447 → 2749)
 *   → composeAgent 里 presets.resolve("ptc-zh") 抛 agent-preset/not-found
 *   → resolve() 包成 gateway/internal: 'resume failed for session "..." :
 *      RemoteError: agent-presets: preset "ptc-zh" not found (available: ...)'
 *   → ctx.emit("api-session/error", ...) —— **进程级全局广播**,发给所有客户端
 *   → 扩展 $events → host/agent-error 帧 → 非当前会话 → 系统通知
 *
 * 也就是说:Mac app(或另一个侧栏)打开一次那个再也起不来的旧会话,Chrome 这边
 * 就凭空弹一条"后台任务失败",标题还是那个早就做完的任务名。这里什么都没做过。
 *
 * 闸门与完成通知同源:background-notifier 的 running 集合只给"见过它在跑"的
 * 会话发完成通知;失败这条路原先漏了同一条规矩。resume 失败的会话连 agent 都没
 * 起来,永远不会出现 running=true,于是被挡在通知之外(行上的红点照旧)。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSessionService } from '../src/features/sessions/session-service.js'

const STALE = 'session-eec75dc0-0e02-4562-9f45-292ef3b3a15a'
const LIVE = 'session-9f1b0754-c05a-453d-b913-6336671848fd'
const RESUME_FAILED =
  'resume failed for session "' + STALE + '": RemoteError: agent-presets: ' +
  'preset "ptc-zh" not found (available: standard, ptc, minimal, cordis)'

const row = (sessionId, extra = {}) => ({ sessionId, running: false, updatedAt: 1, ...extra })

function harness() {
  const failures = []
  const service = createSessionService({
    subscribe() {}, unsubscribe() {}, async call() { return {} }
  }, { onBackgroundTurnFailure: (id, message, title) => failures.push([id, message, title]) })
  service.listStore.replaceAll([
    row(STALE, { projections: { asOfSeq: 1, values: { title: 'Adding team members to OWNERS file PR' } } }),
    row(LIVE)
  ])
  return { service, failures }
}

const emitError = (service, sessionId, message) => service.handleMuxFrame({
  type: 'item', streamId: 'events',
  value: { type: 'emit', event: 'api-session/error', args: [sessionId, message] }
})

test('service:从没跑过的会话 resume 失败,不弹系统通知', () => {
  const { service, failures } = harness()
  service.open(LIVE)
  emitError(service, STALE, RESUME_FAILED)
  assert.deepEqual(failures, [],
    '别人打开一个起不来的旧会话,不该在这边弹"后台任务失败",实际 ' + JSON.stringify(failures))
  // 红点仍要亮:那是"这个会话有一次没看过的失败"的账,不是系统通知。
  assert.equal(service.listStore.isErrored(STALE), true, '失败红点不该被一起吞掉')
})

test('service:同一个会话反复被别的客户端打开,也一条都不弹', () => {
  const { service, failures } = harness()
  service.open(LIVE)
  for (let i = 0; i < 5; i += 1) emitError(service, STALE, RESUME_FAILED)
  assert.deepEqual(failures, [], '每次全局广播都弹一条正是"时不时冒出来"的成因')
})

test('service:真的跑过的后台会话失败,照常通知(带任务标题)', () => {
  const { service, failures } = harness()
  service.open(LIVE)
  service.listStore.setStatus(STALE, true)
  service.listStore.setStatus(STALE, false)
  emitError(service, STALE, 'backend crash')
  assert.deepEqual(failures, [[STALE, 'backend crash', 'Adding team members to OWNERS file PR']],
    '跑过的会话失败仍要通知,闸门不能把整条路关死')
})

test('service:冷启动基线里就在跑的会话(别的客户端起的)算跑过', () => {
  const { service, failures } = harness()
  service.listStore.replaceAll([row(STALE, { running: true }), row(LIVE)])
  service.open(LIVE)
  emitError(service, STALE, 'backend crash')
  assert.equal(failures.length, 1, 'session.list 基线的 running 位同样是"见过它在跑"')
})

test('listStore:hasRunHere 只认真的观察到过的 running,且会话删掉后跟着清', () => {
  const { service } = harness()
  const list = service.listStore
  assert.equal(list.hasRunHere(STALE), false)
  assert.equal(list.hasRunHere(null), false)
  list.setStatus(STALE, true)
  assert.equal(list.hasRunHere(STALE), true)
  list.setStatus(STALE, false)
  assert.equal(list.hasRunHere(STALE), true, '"跑过"是历史事实,不随它停下来而消失')
  list.remove(STALE)
  assert.equal(list.hasRunHere(STALE), false, '会话离开名单后不能留着集合无限增长')
})

test('listStore:全量替换后不在名单里的"跑过"标记会被剪掉', () => {
  const { service } = harness()
  const list = service.listStore
  list.setStatus(STALE, true)
  list.replaceAll([row(LIVE)])
  assert.equal(list.hasRunHere(STALE), false)
})
