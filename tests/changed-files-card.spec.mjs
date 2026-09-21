/**
 * 本轮改动文件卡 + 文件 diff(对齐 mac ChangedFilesCard / TurnChangesStore,
 * 以及 web ui-deliverables 的 changed-files 卡)。
 *
 * 这条面是两段式的:耐久事件 `workspace/changes` 只公告"这一轮有改动记录",
 * 文件清单(摘要)与逐文件对比要按公告事件自己的 seq 去宿主鉴权 GET 路由读。
 * 所以这组用例钉住三件事:
 *   1. store 认领公告(记下 turn → seq),而不是把它落进"未处理的事件"兜底行;
 *   2. 服务只读一次:命中缓存不再发请求,宿主 404 记成"不提供"也不再重试;
 *   3. 页脚渲染:摘要落地后卡片自己填出来,点一行能把宿主给的 hunks 画成 diff。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const { createSessionStore } = await import('../src/features/sessions/session-store.js')
const { createChangesService } = await import('../src/features/changes/changes-service.js')
const { decodeChangesSummary, decodeChangesDiff } = await import('../src/features/changes/turn-changes.js')
const { createTurnTailNode } = await import('../src/features/chat/node-views.js')
const { buildUnifiedDiff, unifiedDiffText } = await import('../src/features/chat/unified-diff.js')

const summaryBody = {
  turn: 1,
  total: 4,
  added: 12,
  deleted: 3,
  files: [
    { path: 'src/a.js', display: 'src/a.js', added: 10, deleted: 2 },
    { path: 'src/b.js', display: 'src/b.js', added: 2, deleted: 1 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
    { path: 'big.bin', display: 'big.bin', added: 0, deleted: 0, oversized: true }
  ]
}

const diffBody = {
  kind: 'text',
  path: 'src/a.js',
  display: 'src/a.js',
  coarse: false,
  hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-gone', '+added'] }]
}

const tailNode = (turn = 1) => ({
  kind: 'turnTail', turn, seq: 9, time: 1000, messageId: null, usage: null, runMs: null
})

/** 一个只认 changes 路由的假连接。 */
function fakeConnection(answers) {
  const calls = []
  return {
    calls,
    async getJson(path, query) {
      calls.push({ path, query })
      const answer = answers[path]
      return typeof answer === 'function' ? answer(query) : answer ?? null
    }
  }
}

test('store:workspace/changes 被认领为公告(turn → seq),不落进未知事件兜底行', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent({ type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } })
  store.applyEvent({ type: 'workspace/changes', seq: 7, time: 1100, surfaceOp: 'append', data: { turn: 1 } })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.changesSeqByTurn.get(1), 7)
  assert.equal(store.changesSeq(1), 7)
  const unknown = (snapshot.nodes ?? []).filter((node) => node.kind === 'unknownSurface')
  assert.equal(unknown.length, 0, '公告不应长出"未处理的事件"行:' + JSON.stringify(unknown))
})

test('store:同一轮的更晚公告替换更早的地址', () => {
  const store = createSessionStore()
  store.reset('s1')
  store.applyEvent({ type: 'workspace/changes', seq: 4, time: 1000, data: { turn: 2 } })
  store.applyEvent({ type: 'workspace/changes', seq: 11, time: 1200, data: { turn: 2 } })
  assert.equal(store.changesSeq(2), 11)
})

test('解码:缺字段的文件条目被跳过,坏摘要整体拒绝', () => {
  const decoded = decodeChangesSummary({
    ...summaryBody,
    files: [...summaryBody.files, { path: 'x', display: '' }, { nope: true }]
  })
  assert.equal(decoded.files.length, 4)
  assert.equal(decodeChangesSummary({ turn: 0, total: 1, added: 0, deleted: 0, files: [] }), null)
  assert.equal(decodeChangesDiff({ kind: 'nope', path: 'a', display: 'a' }), null)
  assert.equal(decodeChangesDiff({ kind: 'binary', path: 'a', display: 'a' }).kind, 'binary')
})

test('服务:摘要只读一次,命中缓存不再请求', async () => {
  const connection = fakeConnection({ '/api/changes.summary': summaryBody })
  const changes = createChangesService(connection)
  const [first, second] = await Promise.all([
    changes.loadSummary('s1', 7),
    changes.loadSummary('s1', 7)
  ])
  assert.equal(first.files.length, 4)
  assert.equal(second.files.length, 4)
  await changes.loadSummary('s1', 7)
  assert.equal(connection.calls.length, 1, '同一条记录只应读一次,实际 ' + connection.calls.length)
  assert.equal(changes.summary('s1', 7).total, 4)
})

test('服务:宿主 404 记成"不提供",不再重试', async () => {
  const connection = fakeConnection({ '/api/changes.summary': null })
  const changes = createChangesService(connection)
  assert.equal(await changes.loadSummary('s1', 7), null)
  assert.equal(await changes.loadSummary('s1', 7), null)
  assert.equal(connection.calls.length, 1)
  assert.equal(changes.isUnavailable('s1', 7), true)
  assert.equal(changes.summary('s1', 7), null)
})

test('服务:传输失败不写缓存,下一次渲染可以重试', async () => {
  let attempt = 0
  const connection = {
    calls: [],
    async getJson(path, query) {
      this.calls.push({ path, query })
      attempt += 1
      if (attempt === 1) throw new Error('backend restarted')
      return summaryBody
    }
  }
  const changes = createChangesService(connection)
  assert.equal(await changes.loadSummary('s1', 7), null)
  assert.equal((await changes.loadSummary('s1', 7)).total, 4)
  assert.equal(connection.calls.length, 2)
})

test('渲染:摘要落地后页脚长出改动文件卡,前 3 行可见、其余折叠', async () => {
  const connection = fakeConnection({ '/api/changes.summary': summaryBody, '/api/changes.diff': diffBody })
  const changes = createChangesService(connection)
  const context = {
    cwd: '/ws',
    changesSeq: () => 7,
    changesSummary: (seq) => changes.summary('s1', seq),
    loadChangesSummary: (seq) => changes.loadSummary('s1', seq),
    changesDiff: (seq, index) => changes.diff('s1', seq, index),
    loadChangesDiff: (seq, index) => changes.loadDiff('s1', seq, index)
  }
  const row = createTurnTailNode(tailNode(), context)
  const card = row.querySelector('.turn-changes')
  assert.ok(card, '应当先挂一个占位卡')
  assert.equal(card.hidden, true, '摘要到达前不画内容')
  await changes.loadSummary('s1', 7)
  await Promise.resolve()
  assert.equal(card.hidden, false)
  assert.match(card.querySelector('.turn-changes-title').textContent, /4/)
  assert.equal(card.querySelectorAll('.turn-changes-row').length, 3, '默认只显示 3 行')
  const counts = [...card.querySelectorAll('.turn-changes-counts')].map((n) => n.textContent)
  assert.match(counts[0], /\+10/)
  card.querySelector('.turn-changes-toggle').dispatchEvent(new dom.window.MouseEvent('click'))
  assert.equal(card.querySelectorAll('.turn-changes-row').length, 4, '展开后显示全部')
  const all = [...card.querySelectorAll('.turn-changes-counts')].map((n) => n.textContent)
  assert.ok(all.some((text) => text.includes('二进制') || text.includes('binary')))
  assert.ok(all.some((text) => text.includes('文件过大') || text.includes('too large')))
})

test('渲染:点一行打开详情,宿主 hunks 画成 diff', async () => {
  const connection = fakeConnection({ '/api/changes.summary': summaryBody, '/api/changes.diff': diffBody })
  const changes = createChangesService(connection)
  const opened = []
  const context = {
    cwd: '/ws',
    changesSeq: () => 7,
    changesSummary: (seq) => changes.summary('s1', seq),
    loadChangesSummary: (seq) => changes.loadSummary('s1', seq),
    changesDiff: (seq, index) => changes.diff('s1', seq, index),
    loadChangesDiff: (seq, index) => changes.loadDiff('s1', seq, index),
    onOpenPath: (path) => opened.push(path)
  }
  const row = createTurnTailNode(tailNode(), context)
  await changes.loadSummary('s1', 7)
  await Promise.resolve()
  row.querySelector('.turn-changes-row').dispatchEvent(new dom.window.MouseEvent('click'))
  const sheet = document.querySelector('.card-detail-body .diff-sheet')
  assert.ok(sheet, '应当打开详情弹窗')
  await changes.loadDiff('s1', 7, 0)
  await Promise.resolve()
  await Promise.resolve()
  const lines = [...sheet.querySelectorAll('.diff-line')]
  assert.equal(lines.length, 3)
  assert.equal(sheet.querySelectorAll('.diff-add').length, 1)
  assert.equal(sheet.querySelectorAll('.diff-del').length, 1)
  assert.equal(sheet.querySelector('.diff-hunk').textContent, '@@ -1,2 +1,3 @@')
  // 详情里的"打开"落到宿主:路径按会话 cwd 补成绝对路径。
  sheet.querySelector('.diff-sheet-open').dispatchEvent(new dom.window.MouseEvent('click'))
  assert.deepEqual(opened, ['/ws/src/a.js'])
  // diff 路由按摘要里的下标寻址。
  const diffCall = connection.calls.find((call) => call.path === '/api/changes.diff')
  assert.equal(diffCall.query.index, 0)
  assert.equal(diffCall.query.seq, 7)
})

test('diff 视图:二进制/过大/无行级改动各自给一句说明而不是空白', async () => {
  const cases = [
    [{ kind: 'binary', path: 'a', display: 'a' }, /二进制|binary/],
    [{ kind: 'oversized', path: 'a', display: 'a' }, /文件过大|too large/],
    [{ kind: 'text', path: 'a', display: 'a', hunks: [], coarse: false }, /没有行级改动|No line changes/]
  ]
  for (const [body, pattern] of cases) {
    const connection = fakeConnection({ '/api/changes.summary': summaryBody, '/api/changes.diff': body })
    const changes = createChangesService(connection)
    const context = {
      changesSeq: () => 7,
      changesSummary: (seq) => changes.summary('s1', seq),
      loadChangesSummary: (seq) => changes.loadSummary('s1', seq),
      changesDiff: (seq, index) => changes.diff('s1', seq, index),
      loadChangesDiff: (seq, index) => changes.loadDiff('s1', seq, index)
    }
    const row = createTurnTailNode(tailNode(), context)
    await changes.loadSummary('s1', 7)
    await Promise.resolve()
    row.querySelector('.turn-changes-row').dispatchEvent(new dom.window.MouseEvent('click'))
    await changes.loadDiff('s1', 7, 0)
    await Promise.resolve()
    await Promise.resolve()
    const note = document.querySelector('.card-detail-body .diff-sheet .diff-note')
    assert.match(note.textContent, pattern)
  }
})

test('diff 视图:行号按 hunk 起点递推,复制形态保留前缀', () => {
  const view = buildUnifiedDiff(diffBody.hunks)
  const gutters = [...view.querySelectorAll('.diff-line')].map(
    (line) => [...line.querySelectorAll('.diff-gutter')].map((cell) => cell.textContent)
  )
  assert.deepEqual(gutters, [['1', '1'], ['2', ''], ['', '2']])
  assert.equal(unifiedDiffText(diffBody.hunks), '@@ -1,2 +1,3 @@\n keep\n-gone\n+added')
})
