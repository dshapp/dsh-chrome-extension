/**
 * Proves the tab-reuse behaviour: an agent acting on a page must adopt the
 * tab the user already has open rather than opening a second copy of it.
 *
 * The worker is loaded directly against a mocked `chrome` API and a real
 * WebSocket server, so these exercise background.js as it actually runs.
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')
const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')

const EXTENSION_ID = 'test-extension-id'

/** Staged chrome.tabs.query answer, or the default single-tab tab list. */
let tabsFixture = null
/** Ordered log of every chrome.tabs.remove call. */
let removedTabs = []
/** The tab ids chrome.tabs.remove was asked to close. */
function resetRemoved() { removedTabs = [] }

function defaultTabs() {
  return [{ id: 100, index: 0, url: 'https://example.com/', title: 'Example', active: true, groupId: -1, windowId: 1, lastAccessed: 1 }]
}

function makeChromeMock() {
  const cdpCalls = []
  const groupCalls = []
  const attachCalls = []
  const timeline = []
  const store = {}
  const storageSession = {}
  const debuggerEvents = []
  const detachListeners = []
  const messageListeners = []
  let attachFails = false
  let nextTabId = 900
  let nextGroupId = 7
  const liveGroups = new Set()
  const groupTitles = new Map()
  const groupUpdates = []
  let tabs = defaultTabs()
  const runTimers = []

  const api = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: '0.0.0-test' }),
      getPlatformInfo: async () => ({ os: 'mac' }),
      onMessage: { addListener(listener) { messageListeners.push(listener) } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        async get(keys) {
          const out = {}
          for (const key of [].concat(keys)) if (key in store) out[key] = store[key]
          return out
        },
        async set(values) { Object.assign(store, values) },
        async remove(keys) { for (const key of [].concat(keys)) delete store[key] },
      },
      session: {
        async get(keys) {
          const out = {}
          for (const key of [].concat(keys)) if (key in storageSession) out[key] = storageSession[key]
          return out
        },
        async set(values) { Object.assign(storageSession, values) },
        async remove(keys) { for (const key of [].concat(keys)) delete storageSession[key] },
      },
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: {
      async create({ url }) {
        timeline.push({ kind: 'tabs.create' })
        const tab = { id: nextTabId++, index: 99, url: url ?? null, title: '', active: false, groupId: -1, windowId: 1, status: 'complete' }
        tabs.push(tab)
        return tab
      },
      async update(id, props) {
        if (props?.url) timeline.push({ kind: 'tabs.navigate', url: props.url })
        const tab = tabs.find((candidate) => candidate.id === id)
        if (tab && props?.url) tab.url = props.url
        return tab || { id, ...props }
      },
      async get(id) {
        const tab = tabs.find((candidate) => candidate.id === id)
        if (!tab) throw new Error(`No tab with id: ${id}`)
        // waitForLoad re-reads status; a fixture omitting it is a settled page.
        return { ...tab, status: tab.status ?? 'complete' }
      },
      async query(opts) {
        if (opts && opts.active) return tabs.filter((tab) => tab.active && tab.windowId === 1)
        if (opts && opts.groupId != null) return tabs.filter((tab) => tab.groupId === opts.groupId)
        return [...tabs]
      },
      async remove(ids) {
        const list = [].concat(ids)
        removedTabs.push(...list)
        tabs = tabs.filter((tab) => !list.includes(tab.id))
      },
      async group(opts) {
        groupCalls.push(opts)
        const groupId = opts.groupId ?? nextGroupId++
        if (opts.groupId != null && !liveGroups.has(groupId)) throw new Error(`No group with id: ${groupId}`)
        liveGroups.add(groupId)
        for (const tab of tabs) if ([].concat(opts.tabIds).includes(tab.id)) tab.groupId = groupId
        return groupId
      },
      // waitForLoad registers here and re-reads tab.status, which already says
      // complete, so no event ever has to be replayed.
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener(listener) { api.__onRemoved = listener } },
    },
    tabGroups: {
      async get(id) {
        if (!liveGroups.has(id)) throw new Error(`No group with id: ${id}`)
        return { id, title: groupTitles.get(id) ?? 'Task', windowId: 1 }
      },
      async update(id, props) {
        groupUpdates.push({ id, ...props })
        if (props?.title) groupTitles.set(id, props.title)
      },
    },
    windows: { async update() { } },
    debugger: {
      async attach() {
        attachCalls.push({ failed: attachFails })
        if (attachFails) throw new Error('Another debugger is already attached to the tab')
      },
      async detach() {},
      onDetach: { addListener(listener) { detachListeners.push(listener) } },
      onEvent: { addListener(listener) { debuggerEvents.push(listener) } },
      async sendCommand(_target, method, params) {
        cdpCalls.push({ method, params })
        timeline.push({ kind: 'cdp', method })
        switch (method) {
          case 'Accessibility.getFullAXTree': return { nodes: [] }
          case 'Runtime.evaluate': return { result: { value: null } }
          default: return {}
        }
      },
    },
  }

  return {
    api,
    cdpCalls,
    groupCalls,
    groupUpdates,
    attachCalls,
    timeline,
    setAttachFails(value) { attachFails = value },
    get tabs() { return tabs },
    setTabs(next) { tabs = next },
    /** Replay a debugger detach, as Chrome emits on a privileged page. */
    emitDetach(tabId) { for (const listener of detachListeners) listener({ tabId }) },
    /** Replay a tab close, as Chrome emits when the user closes one. */
    emitTabRemoved(tabId) { api.__onRemoved?.(tabId) },
    storageSession,
  }
}

let server
let socket
let inbox = []
let waiters = []
let mock

function nextFrame(timeoutMs = 5000) {
  if (inbox.length) return Promise.resolve(inbox.shift())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs)
    waiters.push((frame) => { clearTimeout(timer); resolve(frame) })
  })
}

async function callTool(requestId, name, args) {
  socket.send(JSON.stringify({ type: 'tool_call', requestId, payload: { name, args } }))
  for (;;) {
    const frame = await nextFrame()
    if (frame.type === 'tool_result' && frame.responseToRequestId === requestId) return frame
  }
}

/** Every URL chrome.tabs.create or chrome.tabs.update was pointed at. */
function openedUrls() {
  return mock.timeline.filter((entry) => entry.kind === 'tabs.create' || entry.kind === 'tabs.navigate')
}
function createCount() {
  return mock.timeline.filter((entry) => entry.kind === 'tabs.create').length
}
function navigateUrlCount(url) {
  return mock.timeline.filter((entry) => entry.kind === 'tabs.navigate' && entry.url === url).length
}
function resetTimeline() {
  mock.timeline.length = 0
}

before(async () => {
  server = new WebSocketServer({ port: 0 })
  await new Promise((ready) => server.once('listening', ready))
  const port = server.address().port

  const connected = new Promise((resolve) => {
    server.once('connection', (ws) => {
      socket = ws
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString())
        const waiter = waiters.shift()
        if (waiter) waiter(frame)
        else inbox.push(frame)
      })
      resolve()
    })
  })

  mock = makeChromeMock()
  await mock.api.storage.local.set({ dsh_chrome_url: `ws://127.0.0.1:${port}/chrome/ws` })
  new Function('chrome', 'WebSocket', 'console', source)(mock.api, WebSocket, console)
  await connected
  // Drain the hello frame so the first test starts with a clean inbox, and
  // answer it the way chrome-daemon does: the bridge only counts as connected
  // (and only sends tool results) once the daemon has acknowledged the hello.
  const hello = await nextFrame()
  assert.equal(hello.type, 'hello')
  socket.send(JSON.stringify({ type: 'hello_ack' }))
})

after(() => {
  try { socket?.close() } catch {}
  server?.close()
})

test('navigate reuses an already-open exact tab instead of opening a new one', async () => {
  mock.setTabs([
    { id: 100, url: 'https://example.com/page', title: 'Page', active: true, groupId: -1, windowId: 1, lastAccessed: 10 },
  ])
  resetTimeline()
  const frame = await callTool('r1', 'navigate', { session: 'reuse-exact', url: 'https://example.com/page' })
  assert.equal(frame.payload.error, undefined, JSON.stringify(frame.payload))
  const data = frame.payload.data
  assert.equal(data.success, true)
  assert.equal(data.reused, true)
  assert.equal(data.matchKind, 'exact')
  assert.equal(data.tabId, 100)
  assert.equal(createCount(), 0, 'must not open a new tab')
  assert.equal(navigateUrlCount('https://example.com/page'), 0, 'an exact hit must not reload the page')
})

test('navigate ignores a trailing slash and a fragment when matching', async () => {
  mock.setTabs([
    { id: 101, url: 'https://example.com/docs/', title: 'Docs', active: false, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r2', 'navigate', { session: 'reuse-slash', url: 'https://example.com/docs#intro' })
  assert.equal(frame.payload.data.reused, true)
  assert.equal(frame.payload.data.matchKind, 'exact')
  assert.equal(frame.payload.data.tabId, 101)
  assert.equal(createCount(), 0)
})

test('navigate reuses a query-less page by path and navigates it to the query url', async () => {
  mock.setTabs([
    { id: 102, url: 'https://example.com/search', title: 'Search', active: false, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r3', 'navigate', { session: 'reuse-path', url: 'https://example.com/search?q=cats' })
  const data = frame.payload.data
  assert.equal(data.reused, true)
  assert.equal(data.matchKind, 'page')
  assert.equal(data.tabId, 102)
  assert.equal(createCount(), 0)
  assert.equal(navigateUrlCount('https://example.com/search?q=cats'), 1, 'the path hit must be navigated to the real url')
})

test('navigate does not reuse a different query on the same path', async () => {
  mock.setTabs([
    { id: 103, url: 'https://example.com/search?q=dogs', title: 'Search', active: false, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r4', 'navigate', { session: 'reuse-query', url: 'https://example.com/search?q=cats' })
  assert.equal(frame.payload.data.reused, false)
  assert.equal(createCount(), 1, 'a differing query must not hijack the tab the user is reading')
})

test('navigate opens a tab when nothing matches', async () => {
  mock.setTabs([
    { id: 104, url: 'https://example.com/', title: 'Example', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r5', 'navigate', { session: 'reuse-none', url: 'https://other.test/thing' })
  assert.equal(frame.payload.data.reused, false)
  assert.equal(createCount(), 1, 'no match means a tab is opened')
})

test('navigate with newTab:true opens a fresh tab even when one already matches', async () => {
  mock.setTabs([
    { id: 105, url: 'https://example.com/dup', title: 'Dup', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r6', 'navigate', { session: 'reuse-force', url: 'https://example.com/dup', newTab: true })
  assert.equal(frame.payload.data.reused, false)
  assert.equal(createCount(), 1)
})

test('navigate never adopts this extension\'s own pages', async () => {
  mock.setTabs([
    { id: 106, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html`, title: 'Panel', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r7', 'navigate', { session: 'reuse-self', url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` })
  assert.equal(frame.payload.data.reused, false)
  assert.equal(createCount(), 1)
})

test('a reused tab is attached so page tools work on it', async () => {
  mock.setTabs([
    { id: 107, url: 'https://example.com/tools', title: 'Tools', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  await callTool('r8', 'navigate', { session: 'reuse-tools', url: 'https://example.com/tools' })
  const methods = mock.cdpCalls.map((call) => call.method)
  assert.ok(methods.includes('Page.enable'), 'attach must enable Page for the adopted tab')
  assert.ok(mock.attachCalls.length > 0, 'the adopted tab must be attached')
})

test('close_session leaves a reused tab open and reports it in kept', async () => {
  mock.setTabs([
    { id: 108, url: 'https://example.com/keep', title: 'Keep', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetRemoved()
  await callTool('r9', 'navigate', { session: 'reuse-keep', url: 'https://example.com/keep' })
  const frame = await callTool('r10', 'close_session', { session: 'reuse-keep' })
  assert.equal(frame.payload.error, undefined, JSON.stringify(frame.payload))
  assert.equal(frame.payload.data.closed, 0)
  assert.deepEqual(frame.payload.data.kept, [108])
  assert.ok(!removedTabs.includes(108), 'the user\'s tab must survive close_session')
  assert.ok(mock.tabs.some((tab) => tab.id === 108), 'the tab must still exist')
})

test('close_session force:true closes a reused tab', async () => {
  mock.setTabs([
    { id: 109, url: 'https://example.com/force', title: 'Force', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetRemoved()
  await callTool('r11', 'navigate', { session: 'reuse-force-close', url: 'https://example.com/force' })
  const frame = await callTool('r12', 'close_session', { session: 'reuse-force-close', force: true })
  assert.equal(frame.payload.data.closed, 1)
  assert.ok(removedTabs.includes(109), 'force:true must close it')
})

test('close_tab refuses a borrowed tab unless forced', async () => {
  mock.setTabs([
    { id: 110, url: 'https://example.com/refuse', title: 'Refuse', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetRemoved()
  await callTool('r13', 'navigate', { session: 'reuse-refuse', url: 'https://example.com/refuse' })
  const refused = await callTool('r14', 'close_tab', { session: 'reuse-refuse' })
  assert.equal(refused.payload.data.closed, false)
  assert.equal(refused.payload.data.borrowed, true)
  assert.ok(!removedTabs.includes(110))
  const forced = await callTool('r15', 'close_tab', { session: 'reuse-refuse', force: true })
  assert.equal(forced.payload.data.closed, true)
  assert.ok(removedTabs.includes(110))
})

test('close_session still closes a tab the task opened itself', async () => {
  mock.setTabs([
    { id: 111, url: 'https://example.com/', title: 'Other', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetRemoved()
  const opened = await callTool('r16', 'navigate', { session: 'reuse-own', url: 'https://fresh.test/new' })
  const newId = opened.payload.data.tabId
  const frame = await callTool('r17', 'close_session', { session: 'reuse-own' })
  assert.equal(frame.payload.data.closed, 1)
  assert.ok(removedTabs.includes(newId), 'a tab the task opened is the task\'s to close')
})

test('a tab closed by the user is pruned from the borrowed ledger', async () => {
  mock.setTabs([
    { id: 112, url: 'https://example.com/prune', title: 'Prune', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetRemoved()
  await callTool('r18', 'navigate', { session: 'reuse-prune', url: 'https://example.com/prune' })
  const ledgerBefore = mock.storageSession.dsh_borrowed_tabs
  assert.ok(ledgerBefore && ledgerBefore['reuse-prune']?.includes(112), 'the reused tab must be recorded')
  mock.emitTabRemoved(112)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const ledgerAfter = mock.storageSession.dsh_borrowed_tabs
  assert.ok(!ledgerAfter?.['reuse-prune']?.includes(112), 'a closed tab must not linger in the ledger')
})

test('find_tab borrows a tab by url and records it as borrowed', async () => {
  mock.setTabs([
    { id: 113, url: 'https://example.com/find', title: 'Find', active: false, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetRemoved()
  const frame = await callTool('r19', 'find_tab', { session: 'reuse-find', url: 'https://example.com/find/' })
  assert.equal(frame.payload.error, undefined, JSON.stringify(frame.payload))
  assert.equal(frame.payload.data.tabId, 113)
  assert.equal(frame.payload.data.borrowed, false)
  const closed = await callTool('r20', 'close_session', { session: 'reuse-find' })
  assert.equal(closed.payload.data.closed, 0)
  assert.ok(!removedTabs.includes(113), 'an explicitly borrowed tab must survive close_session')
})

test('list_tabs marks a borrowed tab', async () => {
  mock.setTabs([
    { id: 114, url: 'https://example.com/mark', title: 'Mark', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  await callTool('r21', 'navigate', { session: 'reuse-mark', url: 'https://example.com/mark' })
  const frame = await callTool('r22', 'list_tabs', { session: 'reuse-mark' })
  const listed = frame.payload.data.tabs.find((tab) => tab.tabId === 114)
  assert.ok(listed, 'the adopted tab must be listed')
  assert.equal(listed.borrowed, true)
  assert.equal(listed.current, true)
})

test('navigate reuses a tab that is not the active one', async () => {
  mock.setTabs([
    { id: 115, url: 'https://example.com/active', title: 'Active', active: true, groupId: -1, windowId: 1, lastAccessed: 90 },
    { id: 116, url: 'https://example.com/hidden', title: 'Hidden', active: false, groupId: -1, windowId: 1, lastAccessed: 1 },
  ])
  resetTimeline()
  const frame = await callTool('r23', 'navigate', { session: 'reuse-hidden', url: 'https://example.com/hidden' })
  assert.equal(frame.payload.data.reused, true)
  assert.equal(frame.payload.data.tabId, 116, 'the matching tab wins even when it is in the background')
  assert.equal(createCount(), 0)
})

test('navigate reuses a privileged chrome:// tab without failing', async () => {
  mock.setTabs([
    { id: 117, url: 'chrome://settings/', title: 'Settings', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r24', 'navigate', { session: 'reuse-priv', url: 'chrome://settings/' })
  assert.equal(frame.payload.error, undefined, JSON.stringify(frame.payload))
  assert.equal(frame.payload.data.reused, true)
  assert.equal(frame.payload.data.tabId, 117)
  assert.equal(createCount(), 0)
})

test('navigate never reuses for about:blank', async () => {
  mock.setTabs([
    { id: 118, url: 'about:blank', title: '', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetTimeline()
  const frame = await callTool('r25', 'navigate', { session: 'reuse-blank', url: 'about:blank' })
  assert.equal(frame.payload.error, undefined, JSON.stringify(frame.payload))
  assert.equal(frame.payload.data.reused, false)
  assert.equal(createCount(), 1)
})

// ---------------------------------------------------------------- tab groups
//
// A session bound to one tab must not wrap it in a tab group; the group only
// appears once the session works on a second tab, and then holds all of them.

function resetGroups() {
  mock.groupCalls.length = 0
  mock.groupUpdates.length = 0
}

test('a session on a single opened tab gets no tab group', async () => {
  mock.setTabs([])
  resetGroups()
  const frame = await callTool('g1', 'navigate', { session: 'group-single', url: 'https://one.test/', group_title: 'Solo' })
  assert.equal(frame.payload.error, undefined, JSON.stringify(frame.payload))
  assert.equal(mock.groupCalls.length, 0, 'one tab must not found a group')
  const tab = mock.tabs.find((entry) => entry.id === frame.payload.data.tabId)
  assert.equal(tab.groupId, -1)
  // Navigating the same tab elsewhere is still a single-tab task.
  await callTool('g2', 'navigate', { session: 'group-single', url: 'https://one.test/next' })
  assert.equal(mock.groupCalls.length, 0)
})

test('a session on a single borrowed tab gets no tab group', async () => {
  mock.setTabs([
    { id: 300, url: 'https://user.test/page', title: 'Page', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetGroups()
  await callTool('g3', 'find_tab', { session: 'group-borrow-one', active: true })
  await callTool('g4', 'navigate', { session: 'group-borrow-one', url: 'https://user.test/page' })
  assert.equal(mock.groupCalls.length, 0)
  assert.equal(mock.tabs.find((tab) => tab.id === 300).groupId, -1)
})

test('a second tab founds the group with both tabs, titled by the first navigate', async () => {
  mock.setTabs([])
  resetGroups()
  const first = await callTool('g5', 'navigate', { session: 'group-two', url: 'https://a.test/', group_title: 'Research' })
  assert.equal(mock.groupCalls.length, 0)
  const second = await callTool('g6', 'navigate', { session: 'group-two', url: 'https://b.test/', newTab: true })
  const ids = [first.payload.data.tabId, second.payload.data.tabId]
  assert.equal(mock.groupCalls.length, 1, 'exactly one group is founded')
  assert.deepEqual([...mock.groupCalls[0].tabIds].sort(), [...ids].sort())
  const groupId = mock.tabs.find((tab) => tab.id === ids[0]).groupId
  assert.notEqual(groupId, -1)
  assert.equal(mock.tabs.find((tab) => tab.id === ids[1]).groupId, groupId)
  assert.ok(mock.groupUpdates.some((u) => u.id === groupId && u.title === 'Research'), 'the remembered title names the group')

  // A third tab joins the same group instead of founding another one.
  const third = await callTool('g7', 'navigate', { session: 'group-two', url: 'https://c.test/', newTab: true })
  assert.equal(mock.groupCalls.length, 2)
  assert.equal(mock.groupCalls[1].groupId, groupId)
  assert.equal(mock.tabs.find((tab) => tab.id === third.payload.data.tabId).groupId, groupId)

  // list_tabs reports every tab of the task.
  const listed = await callTool('g8', 'list_tabs', { session: 'group-two' })
  assert.equal(listed.payload.data.tabs.length, 3)

  resetRemoved()
  const closed = await callTool('g9', 'close_session', { session: 'group-two' })
  assert.equal(closed.payload.data.closed, 3)
})

test('a borrowed first tab joins the group once the task opens a second tab', async () => {
  mock.setTabs([
    { id: 310, url: 'https://user.test/doc', title: 'Doc', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
  ])
  resetGroups()
  await callTool('g10', 'navigate', { session: 'group-borrow', url: 'https://user.test/doc' })
  assert.equal(mock.groupCalls.length, 0)
  const opened = await callTool('g11', 'navigate', { session: 'group-borrow', url: 'https://other.test/', newTab: true })
  assert.equal(mock.groupCalls.length, 1)
  assert.deepEqual([...mock.groupCalls[0].tabIds].sort(), [310, opened.payload.data.tabId].sort())
  resetRemoved()
  const closed = await callTool('g12', 'close_session', { session: 'group-borrow' })
  assert.equal(closed.payload.data.closed, 1, 'only the opened tab is closed')
  assert.deepEqual(closed.payload.data.kept, [310], 'the borrowed tab is left open')
})

test('switching to another tab with find_tab founds the group', async () => {
  mock.setTabs([
    { id: 320, url: 'https://user.test/x', title: 'X', active: true, groupId: -1, windowId: 1, lastAccessed: 5 },
    { id: 321, url: 'https://user.test/y', title: 'Y', active: false, groupId: -1, windowId: 1, lastAccessed: 4 },
  ])
  resetGroups()
  await callTool('g13', 'navigate', { session: 'group-find', url: 'https://user.test/x' })
  assert.equal(mock.groupCalls.length, 0)
  await callTool('g14', 'find_tab', { session: 'group-find', url: 'https://user.test/y' })
  assert.equal(mock.groupCalls.length, 1)
  assert.deepEqual([...mock.groupCalls[0].tabIds].sort(), [320, 321])
})

test('a tab the user already grouped is never moved, so no one-tab group appears', async () => {
  mock.setTabs([
    { id: 330, url: 'https://user.test/filed', title: 'Filed', active: true, groupId: 55, windowId: 1, lastAccessed: 5 },
  ])
  resetGroups()
  await callTool('g15', 'navigate', { session: 'group-user', url: 'https://user.test/filed' })
  await callTool('g16', 'navigate', { session: 'group-user', url: 'https://other.test/', newTab: true })
  assert.equal(mock.groupCalls.length, 0, 'one loose tab is not enough to found a group')
  assert.equal(mock.tabs.find((tab) => tab.id === 330).groupId, 55)
})
