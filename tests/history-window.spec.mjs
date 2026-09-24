/**
 * DSH 0.1.7 历史窗口按轮次对齐:follow 开流与所有 session/page 请求都带
 * web session-controller HISTORY_PAGE_OPTIONS 形状(maxMessages:500 +
 * turnWindow{minMessages:50,minTurns:2}),turn rail 跳页用 JUMP_PAGE_OPTIONS
 *(minMessages:200),缺口修复沿用开流窗口(web transport "repairs a live gap
 * preserving history limits")。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createSessionService, HISTORY_PAGE_OPTIONS, JUMP_PAGE_OPTIONS
} from '../src/features/sessions/session-service.js'
import { RPC, STREAM } from '../src/platform/dsh/rpc-methods.js'

const WINDOW = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
const JUMP = { maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } }
const frame = (value) => ({ type: 'item', streamId: 'follow:s1', value })
const entry = (seq) => ({ event: { seq, type: 'turn/start', data: {} } })

function harness(respond = () => ({})) {
  const calls = []
  const subscriptions = []
  const connection = {
    subscribe(streamId, endpoint, args) { subscriptions.push({ streamId, endpoint, args }) },
    unsubscribe() {},
    async call(method, args) {
      calls.push({ method, args })
      return respond(method, args)
    }
  }
  return { service: createSessionService(connection), calls, subscriptions }
}

const pages = (calls) => calls.filter((call) => call.method === RPC.sessionPage).map((call) => call.args.request)

test('常量与 web HISTORY_PAGE_OPTIONS / JUMP_PAGE_OPTIONS 同形', () => {
  assert.deepEqual(HISTORY_PAGE_OPTIONS, WINDOW)
  assert.deepEqual(JUMP_PAGE_OPTIONS, JUMP)
})

test('follow 开流带轮次窗口', async () => {
  const { service, subscriptions } = harness()
  await service.open('s1')
  const follow = subscriptions.find((item) => item.endpoint === STREAM.follow)
  assert.deepEqual(follow.args, {
    request: { address: { kind: 'session', sessionId: 's1' }, ...WINDOW, assistantStream: true }
  })
})

test('loadHistory / loadEarlier 用普通窗口,loadThrough 跳页用 200 条窗口', async () => {
  let earliest = 40
  const { service, calls } = harness((method, args) => {
    if (method !== RPC.sessionPage || args.request.beforeSeq === undefined) return { records: [entry(40)], hasMore: true }
    earliest -= 10
    return { records: [entry(earliest)], hasMore: earliest > 0 }
  })
  await service.open('s1')
  service.handleMuxFrame(frame({ type: 'snapshot', cursor: 41, records: [entry(40), entry(41)], hasMore: true }))
  const address = { kind: 'session', sessionId: 's1' }

  await service.loadHistory('s1')
  assert.deepEqual(pages(calls).at(-1), { address, throughSeq: 41, ...WINDOW })

  await service.loadEarlier('s1')
  assert.deepEqual(pages(calls).at(-1), { address, throughSeq: 41, beforeSeq: 40, ...WINDOW })

  calls.length = 0
  await service.loadThrough('s1', 5)
  const jumps = pages(calls)
  assert.ok(jumps.length >= 1)
  for (const request of jumps) assert.deepEqual(request.turnWindow, JUMP.turnWindow)
  assert.ok(jumps.every((request) => request.maxMessages === 500))
})

test('实时帧缺口修复沿用开流窗口', async () => {
  const { service, calls } = harness(() => ({ records: [entry(1), entry(2), entry(5)] }))
  await service.open('s1')
  service.handleMuxFrame(frame({ type: 'snapshot', cursor: 1, records: [entry(1)] }))
  // seq 2..4 丢了,直接来了 5 —— 缺口。
  service.handleMuxFrame(frame(entry(5)))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(pages(calls).at(-1), {
    address: { kind: 'session', sessionId: 's1' }, throughSeq: 4, ...WINDOW
  })
})
