/**
 * Exercises the service worker's real logic against a mocked `chrome` API and a
 * real WebSocket server. Chrome stable refuses `--load-extension`, and an
 * unpacked extension can otherwise only be loaded by hand, so this is how the
 * worker's behaviour is proven automatically.
 *
 * Proven here: the hello handshake, ping/pong, each tool's dispatch to the
 * right CDP calls, @e refs from the accessibility tree, trusted input, and
 * error reporting.
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

/**
 * What the next wait_for_selector visibility probe should answer. Tests flip
 * this to drive the poll loop toward success or timeout.
 */
let probeAnswer = true

/** Staged page-side answer for select, when a test needs the no-match branch. */
let selectAnswer = null

/** Staged Network.getResponseBody answer, for the evicted-body case. */
let bodyAnswer = null

/** Staged answer for select's control inspection (tag/role/haspopup). */
let inspectAnswer = null

/** Staged visible options for the ARIA dropdown probe. */
let dropdownAnswer = null
let uploadStateAnswer = null

/** Staged answer for the ARIA dropdown's post-choice readback. */
let ariaAfterAnswer = null

/** Staged aria-activedescendant reads, consumed one per evaluation. */
let activeAnswers = []

/** Staged fill answer, for the readback and not-editable shapes. */
let fillAnswer = null

/** Staged element-geometry answer; an explicit null forces "not found". */
let boxAnswer = undefined
/** Staged answers for safe click probes, consumed in order. */
let safeClickAnswers = []
let dropdownInitiallyOpen = false

/** Whether chrome.tabs.get reports the tab as already active. */
let activeAnswer = false

/**
 * The accessibility tree the mocked CDP returns.
 *
 * Shaped like a real Chrome response: the content sits beneath several
 * `ignored` generic wrappers (<html>, <body>, <div>), and it carries one of
 * everything the snapshot filters care about — a `generic` wrapper, an
 * `InlineTextBox`, an unnamed `StaticText`, an `aria-hidden` subtree, a
 * password field, a tri-state checkbox, and prose.
 *
 * A function rather than a constant so a test can stage its own tree.
 */
function defaultAxTree() {
  return {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, childIds: ['2'], ignored: false },
      { nodeId: '2', role: { value: 'none' }, childIds: ['3'], ignored: true },
      { nodeId: '3', role: { value: 'generic' }, childIds: ['4', '5', '6', '7', '8', '10', '12'], ignored: false },
      { nodeId: '4', role: { value: 'link' }, name: { value: 'More' }, backendDOMNodeId: 42, childIds: [], ignored: false },
      { nodeId: '5', role: { value: 'heading' }, name: { value: 'Sign in' }, backendDOMNodeId: 43, childIds: [], ignored: false },
      { nodeId: '6', role: { value: 'InlineTextBox' }, name: { value: 'noise' }, backendDOMNodeId: 44, childIds: [], ignored: false },
      { nodeId: '7', role: { value: 'StaticText' }, name: { value: '' }, backendDOMNodeId: 45, childIds: [], ignored: false },
      {
        nodeId: '8',
        role: { value: 'textbox' },
        name: { value: 'Password' },
        value: { value: 'hunter2' },
        backendDOMNodeId: 46,
        childIds: ['9'],
        ignored: false,
        properties: [{ name: 'autocomplete', value: { value: 'current-password' } }],
      },
      { nodeId: '9', role: { value: 'StaticText' }, name: { value: 'inside password' }, backendDOMNodeId: 47, childIds: [], ignored: false },
      {
        nodeId: '10',
        role: { value: 'group' },
        name: { value: 'Hidden panel' },
        backendDOMNodeId: 48,
        childIds: ['11'],
        ignored: false,
        properties: [{ name: 'hidden', value: { value: 'true' } }],
      },
      { nodeId: '11', role: { value: 'button' }, name: { value: 'Secret' }, backendDOMNodeId: 49, childIds: [], ignored: false },
      {
        nodeId: '12',
        role: { value: 'checkbox' },
        name: { value: 'Remember me' },
        backendDOMNodeId: 50,
        childIds: [],
        ignored: false,
        properties: [{ name: 'checked', value: { value: 'mixed' } }],
      },
    ],
  }
}

/** Staged accessibility tree for the next getFullAXTree, or the default. */
let stagedAxTree = null
function axTree() {
  return stagedAxTree ?? defaultAxTree()
}
function visibilityProbe() {
  return probeAnswer
}

/** A mock of the Chrome APIs the worker touches, recording CDP traffic. */
function makeChromeMock() {
  const cdpCalls = []
  const activations = []
  const groupCalls = []
  const store = {}
  const debuggerEvents = []
  const timeline = []
  let nextTabId = 100
  return {
    cdpCalls,
    activations,
    groupCalls,
    /** Ordered log of the calls whose relative order matters. */
    timeline,
    /** Replay a CDP event at the worker, as Chrome would. */
    emit(tabId, method, params) {
      for (const listener of debuggerEvents) listener({ tabId }, method, params)
    },
    api: {
      runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        onMessage: { addListener() {} },
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
        },
        onChanged: { addListener() {} },
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      tabs: {
        async create({ url }) {
          timeline.push({ kind: 'tabs.create', url: url ?? null })
          return { id: nextTabId++, url, status: 'complete' }
        },
        async update(id, props) {
          activations.push({ id, props })
          if (props?.url) timeline.push({ kind: 'tabs.navigate', url: props.url })
          return { id, ...props }
        },
        async get(id) {
          return { id, url: 'https://example.com/', title: 'Example Domain', status: 'complete', groupId: 7, active: activeAnswer, windowId: 1 }
        },
        async query(opts) {
          const all = [{ id: 100, url: 'https://example.com/', title: 'Example Domain', active: true, groupId: 7 }]
          if (opts && opts.groupId != null) return all.filter((tab) => tab.groupId === opts.groupId)
          return all
        },
        async remove() {},
        async group(opts) { groupCalls.push(opts); return 7 },
        onRemoved: { addListener() {} },
        // waitForLoad both registers here and re-checks tab.status; the mock
        // reports 'complete' immediately, so record listeners for removal only.
        onUpdated: { addListener() {}, removeListener() {} },
      },
      tabGroups: { async get() { return { id: 7, title: 'Task' } }, async update() {} },
      windows: { async update() {} },
      debugger: {
        async attach() {},
        async detach() {},
        onDetach: { addListener() {} },
        onEvent: { addListener(listener) { debuggerEvents.push(listener) } },
        async sendCommand(_target, method, params) {
          cdpCalls.push({ method, params })
          timeline.push({ kind: 'cdp', method })
          switch (method) {
            case 'Runtime.evaluate': {
              const code = params.expression
              // find must be recognized before the publish check below: its
              // expression also seeds the ref table, so the bare assignment is
              // no longer enough to identify snapshot's publish step.
              if (code.includes('const table = globalThis.__dshChromeRefs')) {
                return {
                  result: {
                    value: {
                      matches: [
                        { ref: '@e7', role: 'button', text: 'Sign in', score: 100, selectorHint: '#login' },
                      ],
                    },
                  },
                }
              }
              // Only the publish step assigns the whole ref table; an @e
              // selector merely reads it, so match the assignment specifically.
              if (code.trim() === 'globalThis.__dshChromeRefs = {}') {
                return { result: { value: undefined } }
              }
              if (code.trim() === '({ width: innerWidth, height: innerHeight })') {
                return { result: { value: { width: 1280, height: 720 } } }
              }
              if (code.includes("error: 'obscured'")) {
                const value = safeClickAnswers.length ? safeClickAnswers.shift() : { x: 2.5, y: 4 }
                return { result: { value } }
              }
              if (code.includes('const owner = target.getAttribute') && !code.includes('[role="option"]') && code.includes('return { opened:')) {
                return { result: { value: { opened: dropdownInitiallyOpen } } }
              }
              // select's control inspection: what kind of control is this?
              if (code.includes('__dshChromeUploadInput = input')) {
                return { result: { value: uploadStateAnswer ?? { multiple: true, resolvedBy: 'direct' } } }
              }
              if (code === 'globalThis.__dshChromeUploadInput') {
                return { result: { objectId: 'obj-1' } }
              }
              if (code.includes('haspopup:')) {
                return { result: { value: inspectAnswer ?? { tag: 'select', role: '', haspopup: '' } } }
              }
              // The ARIA dropdown's option probe. Must be recognized before the
              // generic getClientRects probe rule below, which it also contains.
              if (code.includes('[role="option"]')) {
                return { result: { value: dropdownAnswer ?? { options: [] } } }
              }
              // The keyboard walk's aria-activedescendant read.
              if (code.includes('activeId')) {
                return { result: { value: activeAnswers.length ? activeAnswers.shift() : { activeId: '', text: '' } } }
              }
              // The ARIA dropdown's post-choice readback.
              if (code.includes('aria-expanded')) {
                return { result: { value: ariaAfterAnswer ?? { expanded: 'false', display: '' } } }
              }
              // snapshot's scoped-selector resolution asks for a handle, not a value.
              if (code.includes('return el || null')) {
                return { result: { objectId: 'obj-scope' } }
              }
              if (code.includes('.click()')) return { result: { value: { tag: 'button', text: 'Go' } } }
              if (code.includes('insertText') || code.includes('el.value = text')) {
                return { result: { value: fillAnswer ?? { tag: 'input', mode: 'value' } } }
              }
              // select reports the option it matched, or the no-option answer a
              // test has staged.
              if (code.includes('selectedIndex')) {
                return { result: { value: selectAnswer ?? { value: 'ca', text: 'California', index: 2 } } }
              }
              // get_text inlines its raw flag as a literal, so the mock can tell
              // the two modes apart the same way the page would.
              if (code.includes('cloneNode')) {
                return {
                  result: {
                    value: code.includes('if (true) return document.body')
                      ? 'Nav Home About\nraw body text'
                      : 'Article body.\n\n\n\n\nMore prose.',
                  },
                }
              }
              // wait_for_selector's visibility probe.
              if (code.includes('getClientRects')) {
                return { result: { value: visibilityProbe() } }
              }
              if (code.includes('scrollBy')) {
                return {
                  result: {
                    value: { scrolledBy: { x: 0, y: 600 }, from: { top: 0, left: 0 }, to: { top: 600, left: 0 }, moved: true, atEnd: false },
                  },
                }
              }
              if (code.includes('getBoundingClientRect')) {
                if (boxAnswer !== undefined) return { result: { value: boxAnswer } }
                return { result: { value: { x: 1, y: 2, width: 3, height: 4, centerX: 2.5, centerY: 4, inViewport: true } } }
              }
              if (code.includes('el.focus()') && code.includes('activeElement')) {
                return { result: { value: { tag: 'input', focused: true } } }
              }
              return { result: { value: 'Example Domain' } }
            }
            case 'Accessibility.getFullAXTree':
              return axTree()
            case 'Page.captureScreenshot': return { data: 'QUJD' }
            case 'Network.getResponseBody':
              // A staged Error is thrown, mirroring the rejecting shape of
              // chrome.debugger; anything else is returned as a resolved value.
              if (bodyAnswer instanceof Error) throw bodyAnswer
              return bodyAnswer ?? { body: '{"ok":true}', base64Encoded: false }
            case 'Page.handleJavaScriptDialog': return {}
            case 'Page.printToPDF': return { data: 'JVBERi0=' }
            case 'DOM.resolveNode': return { object: { objectId: 'obj-1' } }
            case 'DOM.describeNode': return { node: { backendNodeId: 42 } }
            default: return {}
          }
        },
      },
    },
  }
}

let server
let port
/** The live extension socket, and a queue of frames it has sent. */
let socket
let inbox = []
let waiters = []
let mock

/** Resolve with the next frame the worker sends. */
function nextFrame(timeoutMs = 5000) {
  if (inbox.length) return Promise.resolve(inbox.shift())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs)
    waiters.push((frame) => { clearTimeout(timer); resolve(frame) })
  })
}

/** Send a tool_call and return its matching tool_result. */
async function callTool(requestId, name, args) {
  socket.send(JSON.stringify({ type: 'tool_call', requestId, payload: { name, args } }))
  for (;;) {
    const frame = await nextFrame()
    if (frame.type === 'tool_result' && frame.responseToRequestId === requestId) return frame
  }
}

before(async () => {
  server = new WebSocketServer({ port: 0 })
  await new Promise((ready) => server.once('listening', ready))
  port = server.address().port

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
  // The bridge now derives its socket from the extension-wide DSH backend
  // setting. Seed that same storage key instead of patching a daemon constant.
  await mock.api.storage.local.set({ codemax_dsh_backend_url: `http://127.0.0.1:${port}` })
  new Function('chrome', 'WebSocket', 'console', source)(mock.api, WebSocket, console)
  await connected
})

after(() => {
  try { socket?.close() } catch {}
  server?.close()
})

test('announces itself with a hello frame carrying its version', async () => {
  const hello = await nextFrame()
  assert.equal(hello.type, 'hello')
  assert.equal(hello.payload.extensionVersion, '0.1.0')
})

test('answers a ping with a pong', async () => {
  socket.send(JSON.stringify({ type: 'ping' }))
  const frame = await nextFrame()
  assert.equal(frame.type, 'pong')
})

test('navigate opens a tab and reports it', async () => {
  const frame = await callTool('n1', 'navigate', {
    session: 's', url: 'https://example.com', newTab: true, group_title: 'Task',
  })
  assert.equal(frame.payload.error, undefined)
  assert.equal(frame.payload.data.success, true)
  assert.ok(frame.payload.data.tabId)
})

test('snapshot returns an indented outline whose refs name backend node ids', async () => {
  const frame = await callTool('s1', 'snapshot', { session: 's' })
  const { title, tree, mode } = frame.payload.data
  assert.equal(title, 'Example Domain')
  assert.equal(mode, 'interactive')
  // The ref is the element's backend node id, not its position in the walk.
  assert.match(tree, /@e42 link "More"/, tree)
  // Indented text, not JSON: no braces, quoted keys, or commas between nodes.
  assert.doesNotMatch(tree, /"ref":/, 'the outline must not be JSON')
})

test('click resolves an @e ref against the published refs', async () => {
  const frame = await callTool('c1', 'click', { session: 's', selector: '@e1' })
  assert.equal(frame.payload.error, undefined)
  assert.equal(frame.payload.data.success, true)
  const evaluated = mock.cdpCalls.filter((call) => call.method === 'Runtime.evaluate')
  assert.ok(
    evaluated.some((call) => call.params.expression.includes('__dshChromeRefs')),
    'click must resolve @e refs through the published ref table',
  )
})

test('fill reports the editing mode it used', async () => {
  const frame = await callTool('f1', 'fill', { session: 's', selector: '#q', value: 'hello' })
  assert.equal(frame.payload.data.mode, 'value')
})

test('upload passes file paths directly to Chrome for a file input', async () => {
  const before = mock.cdpCalls.length
  const frame = await callTool('u1', 'upload', {
    session: 's', selector: '#file', paths: ['/tmp/hello.txt'],
  })
  assert.equal(frame.payload.error, undefined, frame.payload.error)
  assert.deepEqual(frame.payload.data, { success: true, count: 1, resolvedBy: 'direct' })
  const calls = mock.cdpCalls.slice(before)
  const setFiles = calls.find((call) => call.method === 'DOM.setFileInputFiles')
  assert.deepEqual(setFiles.params.files, ['/tmp/hello.txt'])
  assert.equal(setFiles.params.objectId, 'obj-1')
  assert.ok(calls.some((call) => call.method === 'Runtime.releaseObject'))
})

test('upload resolves a visible trigger to its unique nested file input', async () => {
  uploadStateAnswer = { multiple: false, resolvedBy: 'container' }
  const frame = await callTool('u-trigger', 'upload', {
    session: 's', selector: '@e466', paths: ['/tmp/logo.png'],
  })
  uploadStateAnswer = null
  assert.deepEqual(frame.payload.data, { success: true, count: 1, resolvedBy: 'container' })
})

test('upload rejects ambiguous trigger containers instead of guessing', async () => {
  uploadStateAnswer = { error: 'ambiguous', count: 2 }
  const frame = await callTool('u-ambiguous', 'upload', {
    session: 's', selector: '#uploads', paths: ['/tmp/logo.png'],
  })
  uploadStateAnswer = null
  assert.match(frame.payload.error, /2 file inputs/)
  assert.match(frame.payload.error, /more specific selector/)
})

test('upload rejects multiple paths on a single-file input', async () => {
  uploadStateAnswer = { multiple: false }
  const frame = await callTool('u2', 'upload', {
    session: 's', selector: '#file', paths: ['/tmp/a.txt', '/tmp/b.txt'],
  })
  uploadStateAnswer = null
  assert.match(frame.payload.error, /does not allow multiple files/)
})

test('screenshot returns an image the daemon can turn into an image block', async () => {
  const frame = await callTool('p1', 'screenshot', { session: 's', format: 'png' })
  assert.equal(frame.payload.data.__image_mime_type, 'image/png')
  assert.equal(frame.payload.data.__image_base64, 'QUJD')
})

test('mouse_click dispatches trusted input, not a synthetic click', async () => {
  const before = mock.cdpCalls.length
  const frame = await callTool('m1', 'mouse_click', { session: 's', x: 10, y: 20 })
  assert.equal(frame.payload.data.trusted, true)
  // Focusing the tab may evaluate a focus-restoring snippet first, so assert on
  // the mouse events themselves rather than the exact call sequence.
  const mouseEvents = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Input.dispatchMouseEvent')
  // A hover precedes the press: hover-sensitive widgets arm on pointer
  // arrival, and no real user presses without the pointer arriving first.
  assert.deepEqual(
    mouseEvents.map((call) => call.params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  )
})

test('send_keys maps a chord to modifiers and a key', async () => {
  const before = mock.cdpCalls.length
  const frame = await callTool('k1', 'send_keys', { session: 's', keys: 'Control+A' })
  assert.equal(frame.payload.data.trusted, true)
  const keyEvents = mock.cdpCalls.slice(before).filter((c) => c.method === 'Input.dispatchKeyEvent')
  assert.equal(keyEvents.length, 2)
  // Control is bit 2 in the CDP modifier mask.
  assert.equal(keyEvents[0].params.modifiers, 2)
  assert.equal(keyEvents[0].params.key, 'A')
})

test('an unknown tool is reported as an error frame', async () => {
  const frame = await callTool('e1', 'no_such_tool', {})
  assert.match(frame.payload.error, /unknown tool/)
})

test('acting on a session that never navigated is a clear error', async () => {
  const frame = await callTool('e2', 'snapshot', { session: 'never-opened' })
  assert.match(frame.payload.error, /has no tab yet/)
})
// --- Regressions found by driving a real Chrome ---------------------------

test('snapshot keeps content that sits under ignored wrapper nodes', async () => {
  // Chrome marks <html>/<body>/<div> as ignored; an earlier build returned the
  // subtree as null and the whole page collapsed to a bare root.
  const frame = await callTool('r1', 'snapshot', { session: 's' })
  const tree = frame.payload.data.tree
  assert.match(tree, /@e42 link "More"/, `the link below the wrappers must survive: ${tree}`)
})

test('snapshot drops the roles that carry no meaning of their own', async () => {
  const { payload } = await callTool('s-skip', 'snapshot', { session: 's', mode: 'full' })
  const tree = payload.data.tree
  assert.doesNotMatch(tree, /InlineTextBox/, 'per-line text splits repeat their parent')
  assert.doesNotMatch(tree, /generic/, 'anonymous wrappers add nesting and no content')
  assert.doesNotMatch(tree, /StaticText$/m, 'an unnamed StaticText says nothing')
})

test('snapshot drops an aria-hidden node and everything beneath it', async () => {
  // The child is a plain button: it survives on its own merits, so its absence
  // proves the hidden flag is inherited rather than checked per node.
  const { payload } = await callTool('s-hidden', 'snapshot', { session: 's', mode: 'full' })
  assert.doesNotMatch(payload.data.tree, /Hidden panel/)
  assert.doesNotMatch(payload.data.tree, /Secret/, 'a hidden container hides its children')
})

test('interactive mode keeps controls and headings but drops prose', async () => {
  const interactive = await callTool('s-i', 'snapshot', { session: 's' })
  assert.match(interactive.payload.data.tree, /heading "Sign in"/)
  assert.doesNotMatch(interactive.payload.data.tree, /inside password/, 'prose belongs to get_text')

  const full = await callTool('s-f', 'snapshot', { session: 's', mode: 'full' })
  assert.match(full.payload.data.tree, /inside password/, 'full mode keeps the text node')
})

test('text mode returns prose and no refs to act on', async () => {
  const { payload } = await callTool('s-t', 'snapshot', { session: 's', mode: 'text' })
  assert.match(payload.data.tree, /inside password/)
  assert.doesNotMatch(payload.data.tree, /@e/, 'text mode describes, it does not offer handles')
})

test('a password value is masked at a fixed width', async () => {
  const { payload } = await callTool('s-pw', 'snapshot', { session: 's' })
  assert.doesNotMatch(payload.data.tree, /hunter2/, 'the secret must never reach the model')
  // Fixed width: a proportional mask would leak the password's length.
  assert.match(payload.data.tree, /val="\u2022{8}"/, payload.data.tree)
})

test('a tri-state checkbox reports mixed rather than collapsing to a bool', async () => {
  const { payload } = await callTool('s-cb', 'snapshot', { session: 's' })
  assert.match(payload.data.tree, /@e50 checkbox "Remember me" \[\/\]/, payload.data.tree)
})

test('snapshot enforces its fixed internal safety limit', async () => {
  const tree = defaultAxTree()
  const extras = []
  for (let index = 0; index < 1000; index += 1) {
    const nodeId = `limit-${index}`
    extras.push(nodeId)
    tree.nodes.push({
      nodeId, role: { value: 'button' }, name: { value: `Large output row ${index} ${'x'.repeat(40)}` },
      backendDOMNodeId: 2000 + index, childIds: [], ignored: false,
    })
  }
  tree.nodes[2].childIds.push(...extras)
  stagedAxTree = tree
  try {
    const { payload } = await callTool('s-bud', 'snapshot', { session: 's' })
    assert.equal(payload.data.truncated, true)
    assert.match(payload.data.tree, /# truncated: \d+ more nodes/, payload.data.tree)
    const body = payload.data.tree.split('\n').filter((line) => !line.startsWith('# truncated'))
    assert.ok(Math.ceil((body.join('\n').length + 1) / 4) <= 2000, 'fixed safety limit exceeded')
  } finally {
    stagedAxTree = null
  }
})

test('refs survive an unrelated change elsewhere on the page', async () => {
  // The old scheme numbered refs by walk position, so inserting one element
  // renumbered every element after it and invalidated refs the agent held.
  const before = await callTool('s-ref1', 'snapshot', { session: 's' })
  const tree = defaultAxTree()
  tree.nodes[2].childIds.unshift('99')
  tree.nodes.push({
    nodeId: '99', role: { value: 'button' }, name: { value: 'Added first' },
    backendDOMNodeId: 7, childIds: [], ignored: false,
  })
  stagedAxTree = tree
  try {
    const after = await callTool('s-ref2', 'snapshot', { session: 's' })
    assert.match(before.payload.data.tree, /@e50 checkbox/)
    assert.match(after.payload.data.tree, /@e50 checkbox/, 'the checkbox keeps its ref')
    assert.match(after.payload.data.tree, /@e7 button "Added first"/)
  } finally {
    stagedAxTree = null
  }
})

test('first diff returns every row as added', async () => {
  const { payload } = await callTool('s-first-diff', 'navigate', {
    session: 's-first-diff', url: 'https://example.com',
  }).then(() => callTool('s-first-diff-snapshot', 'snapshot', { session: 's-first-diff', diff: true }))
  const lines = payload.data.tree.split('\n')
  assert.ok(lines.length > 0)
  assert.ok(lines.every((line) => line.endsWith('[+]')), payload.data.tree)
  assert.equal(payload.data.nodeCount, lines.length)
  assert.equal(payload.data.truncated, false)
})

test('unchanged diff is empty and reports zero output nodes', async () => {
  await callTool('s-empty-diff-1', 'navigate', { session: 's-empty-diff', url: 'https://example.com' })
  await callTool('s-empty-diff-2', 'snapshot', { session: 's-empty-diff', diff: true })
  const { payload } = await callTool('s-empty-diff-3', 'snapshot', { session: 's-empty-diff', diff: true })
  assert.equal(payload.data.tree, '')
  assert.equal(payload.data.nodeCount, 0)
  assert.equal(payload.data.truncated, false)
})

test('diff returns only changed rows and lists refs that went away', async () => {
  await callTool('s-d1', 'snapshot', { session: 's', diff: true })
  const tree = defaultAxTree()
  // Drop the link, and flip the checkbox from mixed to checked. A node Chrome
  // no longer reports is gone from the payload entirely, not merely unlinked
  // from its parent — an unlinked node is a detached one, which is different.
  tree.nodes[2].childIds = tree.nodes[2].childIds.filter((id) => id !== '4')
  tree.nodes = tree.nodes.filter((node) => node.nodeId !== '4')
  tree.nodes[tree.nodes.length - 1].properties = [{ name: 'checked', value: { value: 'true' } }]
  tree.nodes.push({
    nodeId: '98', role: { value: 'button' }, name: { value: 'Brand new' },
    backendDOMNodeId: 77, childIds: [], ignored: false,
  })
  tree.nodes[2].childIds.push('98')
  stagedAxTree = tree
  try {
    const { payload } = await callTool('s-d2', 'snapshot', { session: 's', diff: true })
    const out = payload.data.tree
    assert.match(out, /@e77 button "Brand new" \[\+\]/, out)
    assert.match(out, /@e50 checkbox "Remember me" \[x\] \[~\]/, out)
    assert.match(out, /# removed: @e42/, out)
    assert.doesNotMatch(out, /@e46 textbox "Password"/, 'unchanged rows must be omitted')
    assert.equal(payload.data.nodeCount, 2, 'nodeCount describes changed output rows')
    assert.equal(payload.data.truncated, false)
  } finally {
    stagedAxTree = null
  }
})

test('diff still publishes refs for the complete current tree', async () => {
  await callTool('s-refs-diff-1', 'navigate', { session: 's-refs-diff', url: 'https://example.com' })
  await callTool('s-refs-diff-2', 'snapshot', { session: 's-refs-diff', diff: true })
  const before = mock.cdpCalls.length
  const { payload } = await callTool('s-refs-diff-3', 'snapshot', { session: 's-refs-diff', diff: true })
  assert.equal(payload.data.tree, '')
  const made = mock.cdpCalls.slice(before)
  const resolved = made.filter((call) => call.method === 'DOM.resolveNode').length
  assert.equal(resolved, 3, 'all current interactive refs are republished')
})

test('diff applies the fixed safety limit only to changed rows', async () => {
  await callTool('s-budget-diff-1', 'navigate', { session: 's-budget-diff', url: 'https://example.com' })
  await callTool('s-budget-diff-2', 'snapshot', { session: 's-budget-diff', diff: true })
  const tree = defaultAxTree()
  const extras = []
  for (let index = 0; index < 1000; index += 1) {
    const nodeId = `diff-limit-${index}`
    extras.push(nodeId)
    tree.nodes.push({
      nodeId, role: { value: 'button' }, name: { value: `Changed output row ${index} ${'x'.repeat(40)}` },
      backendDOMNodeId: 3000 + index, childIds: [], ignored: false,
    })
  }
  tree.nodes[2].childIds.push(...extras)
  stagedAxTree = tree
  try {
    const { payload } = await callTool('s-budget-diff-3', 'snapshot', { session: 's-budget-diff', diff: true })
    assert.equal(payload.data.truncated, true)
    assert.match(payload.data.tree, /\[\+\]/)
    assert.doesNotMatch(payload.data.tree, /@e42 link "More"/, 'unchanged rows must not consume the limit')
    assert.match(payload.data.tree, /# truncated: \d+ more nodes/)
  } finally {
    stagedAxTree = null
  }
})

test('each snapshot replaces the ref table instead of growing it', async () => {
  // Every entry is a live DOM element. A table that merged across snapshots
  // pinned every element the tab had ever described, and past a few hundred
  // Chrome began refusing Runtime.callFunctionOn with "Object reference chain
  // is too long" — so the second snapshot of a large page always failed.
  const before = mock.cdpCalls.length
  await callTool('s-reset', 'snapshot', { session: 's' })
  const assignments = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Runtime.evaluate')
    .filter((call) => call.params.expression.includes('__dshChromeRefs ='))
  assert.equal(assignments.length, 1, 'the table must be assigned exactly once')
  assert.match(
    assignments[0].params.expression.trim(),
    /^globalThis\.__dshChromeRefs = \{\}$/,
    'the table must be replaced, not merged into',
  )
})

test('publishRefs releases every object handle it resolves', async () => {
  // Chrome refuses DOM.resolveNode with "Object reference chain is too long"
  // once too many handles are outstanding, which took out mode:"full" on a
  // large page. Every resolved handle must be released again.
  const tree = defaultAxTree()
  const extras = []
  for (let index = 0; index < 80; index += 1) {
    const nodeId = `b${index}`
    extras.push(nodeId)
    tree.nodes.push({
      nodeId, role: { value: 'button' }, name: { value: `Button ${index}` },
      backendDOMNodeId: 1000 + index, childIds: [], ignored: false,
    })
  }
  tree.nodes[2].childIds.push(...extras)
  stagedAxTree = tree
  const before = mock.cdpCalls.length
  try {
    await callTool('s-rel', 'snapshot', { session: 's' })
  } finally {
    stagedAxTree = null
  }
  const made = mock.cdpCalls.slice(before)
  const resolved = made.filter((call) => call.method === 'DOM.resolveNode').length
  const released = made.filter((call) => call.method === 'Runtime.releaseObject').length
  assert.ok(resolved >= 80, `every control must be resolved, got ${resolved}`)
  assert.equal(released, resolved, 'each resolved handle must be released')
})

test('attaching enables the Accessibility domain', async () => {
  // Without Accessibility.enable, getFullAXTree answers with a stub root only.
  const enabled = mock.cdpCalls.filter((call) => call.method === 'Accessibility.enable')
  assert.ok(enabled.length >= 1, 'Accessibility.enable must be sent on attach')
})

test('evaluate accepts a multi-statement body, not just an expression', async () => {
  const frame = await callTool('r3', 'evaluate', { session: 's', code: 'const n = 1; return n' })
  assert.equal(frame.payload.error, undefined, `body form must compile: ${frame.payload.error}`)
})

test('trusted input activates its tab first', async () => {
  // Chrome silently drops synthesized input aimed at a background tab.
  const before = mock.activations.length
  await callTool('r4', 'send_keys', { session: 's', keys: 'Enter' })
  const activated = mock.activations.slice(before).filter((entry) => entry.props?.active === true)
  assert.ok(activated.length >= 1, 'send_keys must activate the tab before dispatching')
})

test('Enter is dispatched as a raw key event so the page submits', async () => {
  // A 'keyDown' carrying text inserts a newline instead of submitting.
  const before = mock.cdpCalls.length
  await callTool('r5', 'send_keys', { session: 's', keys: 'Enter' })
  const keyEvents = mock.cdpCalls.slice(before).filter((c) => c.method === 'Input.dispatchKeyEvent')
  assert.equal(keyEvents[0].params.type, 'rawKeyDown')
  assert.equal(keyEvents[0].params.text, undefined, 'Enter must not carry text')
})

test('focus reports that the element took keyboard focus', async () => {
  await callTool('40', 'navigate', { session: 's-focus', url: 'https://example.com' })
  const frame = await callTool('41', 'focus', { session: 's-focus', selector: '#name' })
  assert.equal(frame.payload.data.focused, true)
})

test('select matches an option by its visible text', async () => {
  await callTool('42', 'navigate', { session: 's-select', url: 'https://example.com' })
  const frame = await callTool('43', 'select', { session: 's-select', selector: '#state', value: 'California' })
  assert.equal(frame.payload.data.text, 'California')
  assert.equal(frame.payload.data.index, 2)
})

test('select lists the available options when none matches', async () => {
  await callTool('44', 'navigate', { session: 's-sel2', url: 'https://example.com' })
  // Drive the page-side no-option branch: the mock echoes the shape the real
  // expression returns when its layered matching finds nothing.
  selectAnswer = { error: 'no-option', available: ['Alabama', 'Alaska'] }
  const frame = await callTool('45', 'select', { session: 's-sel2', selector: '#state', value: 'Narnia' })
  selectAnswer = null
  assert.match(frame.payload.error, /no option matching "Narnia"/)
  assert.match(frame.payload.error, /Alabama \| Alaska/)
})

test('scroll reports whether the position actually moved', async () => {
  await callTool('46', 'navigate', { session: 's-scroll', url: 'https://example.com' })
  const frame = await callTool('47', 'scroll', { session: 's-scroll', direction: 'down' })
  assert.equal(frame.payload.data.moved, true)
  assert.equal(frame.payload.data.atEnd, false)
})

test('scroll_into_view returns the element geometry', async () => {
  await callTool('48', 'navigate', { session: 's-siv', url: 'https://example.com' })
  const frame = await callTool('49', 'scroll_into_view', { session: 's-siv', selector: '@e1' })
  assert.equal(frame.payload.data.width, 3)
  assert.equal(frame.payload.data.inViewport, true)
})

test('find returns a reusable ref for a plain-language query', async () => {
  await callTool('50', 'navigate', { session: 's-find', url: 'https://example.com' })
  const frame = await callTool('51', 'find', { session: 's-find', query: 'sign in button' })
  assert.equal(frame.payload.data.best, '@e7')
  assert.equal(frame.payload.data.matches[0].selectorHint, '#login')
})

test('wait clamps a request above the 3000ms ceiling', async () => {
  const frame = await callTool('52', 'wait', { session: 's-wait', ms: 99999 })
  assert.equal(frame.payload.data.waited, 3000)
  assert.equal(frame.payload.data.clamped, true)
})

test('wait needs no tab, because a session may not have navigated yet', async () => {
  const frame = await callTool('53', 'wait', { session: 's-never-navigated', ms: 1 })
  assert.equal(frame.payload.data.success, true)
})

test('wait_for_selector returns as soon as the element is visible', async () => {
  await callTool('54', 'navigate', { session: 's-wfs', url: 'https://example.com' })
  probeAnswer = true
  const frame = await callTool('55', 'wait_for_selector', { session: 's-wfs', selector: '#ready' })
  assert.equal(frame.payload.data.state, 'visible')
})

test('wait_for_selector times out with the elapsed time in the message', async () => {
  await callTool('56', 'navigate', { session: 's-wfs2', url: 'https://example.com' })
  probeAnswer = false
  const frame = await callTool('57', 'wait_for_selector', { session: 's-wfs2', selector: '#missing', timeout: 300 })
  probeAnswer = true
  assert.match(frame.payload.error, /not visible after \d+ms/)
})

test('wait_for_selector state:hidden succeeds when the element is absent', async () => {
  await callTool('58', 'navigate', { session: 's-wfs3', url: 'https://example.com' })
  probeAnswer = false
  const frame = await callTool('59', 'wait_for_selector', { session: 's-wfs3', selector: '#gone', state: 'hidden' })
  probeAnswer = true
  assert.equal(frame.payload.data.state, 'hidden')
})

test('network lists recorded requests and filters them', async () => {
  const opened = await callTool('60', 'navigate', { session: 's-net', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Network.requestWillBeSent', {
    requestId: 'req-1', type: 'XHR', request: { method: 'POST', url: 'https://example.com/api/login', headers: { a: '1' } },
  })
  mock.emit(tabId, 'Network.responseReceived', {
    requestId: 'req-1', response: { status: 401, statusText: 'Unauthorized', mimeType: 'application/json', headers: {} },
  })
  mock.emit(tabId, 'Network.requestWillBeSent', {
    requestId: 'req-2', type: 'Image', request: { method: 'GET', url: 'https://cdn.example.com/logo.png', headers: {} },
  })

  const all = await callTool('62', 'network', { session: 's-net' })
  assert.equal(all.payload.data.requests.length, 2)

  const posts = await callTool('63', 'network', { session: 's-net', method: 'POST' })
  assert.equal(posts.payload.data.requests.length, 1)
  assert.equal(posts.payload.data.requests[0].status, 401)

  const byStatus = await callTool('64', 'network', { session: 's-net', status: 401 })
  assert.equal(byStatus.payload.data.requests[0].requestId, 'req-1')

  const byUrl = await callTool('65', 'network', { session: 's-net', filter: 'cdn.' })
  assert.equal(byUrl.payload.data.requests[0].requestId, 'req-2')
})

test('network_detail fetches the response body only when asked', async () => {
  const opened = await callTool('66', 'navigate', { session: 's-detail', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Network.requestWillBeSent', {
    requestId: 'req-9', type: 'XHR', request: { method: 'GET', url: 'https://example.com/api/me', headers: { accept: 'json' } },
  })
  mock.emit(tabId, 'Network.responseReceived', {
    requestId: 'req-9', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { server: 'test' } },
  })

  const without = await callTool('68', 'network_detail', { session: 's-detail', requestId: 'req-9' })
  assert.equal(without.payload.data.body, undefined)
  assert.equal(without.payload.data.requestHeaders.accept, 'json')

  const withBody = await callTool('69', 'network_detail', { session: 's-detail', requestId: 'req-9', body: true })
  assert.equal(withBody.payload.data.body, '{"ok":true}')
  assert.equal(withBody.payload.data.bodyTruncated, false)
})

test('network_detail rejects an unknown requestId', async () => {
  await callTool('70', 'navigate', { session: 's-detail2', url: 'https://example.com' })
  const frame = await callTool('71', 'network_detail', { session: 's-detail2', requestId: 'nope' })
  assert.match(frame.payload.error, /no request nope/)
})

test('dialog errors when no dialog is open', async () => {
  await callTool('72', 'navigate', { session: 's-dlg', url: 'https://example.com' })
  const frame = await callTool('73', 'dialog', { session: 's-dlg', action: 'accept' })
  assert.match(frame.payload.error, /no dialog is open/)
})

test('dialog accepts a prompt and forwards the text', async () => {
  const opened = await callTool('74', 'navigate', { session: 's-dlg2', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Your name?', defaultPrompt: '' })

  const frame = await callTool('76', 'dialog', { session: 's-dlg2', action: 'accept', text: 'Ada' })
  assert.equal(frame.payload.data.action, 'accept')
  assert.equal(frame.payload.data.dialogType, 'prompt')
  const handled = mock.cdpCalls.filter((call) => call.method === 'Page.handleJavaScriptDialog').pop()
  assert.equal(handled.params.accept, true)
  assert.equal(handled.params.promptText, 'Ada')

  // The dialog is consumed, so a second answer must fail rather than hang.
  const again = await callTool('77', 'dialog', { session: 's-dlg2', action: 'accept' })
  assert.match(again.payload.error, /no dialog is open/)
})

test('dialog dismiss sends accept:false', async () => {
  const opened = await callTool('78', 'navigate', { session: 's-dlg3', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
  const frame = await callTool('80', 'dialog', { session: 's-dlg3', action: 'dismiss' })
  assert.equal(frame.payload.data.action, 'dismiss')
  const handled = mock.cdpCalls.filter((call) => call.method === 'Page.handleJavaScriptDialog').pop()
  assert.equal(handled.params.accept, false)
})

test('get_text strips noise by default and collapses blank runs', async () => {
  await callTool('81', 'navigate', { session: 's-text', url: 'https://example.com' })
  const frame = await callTool('82', 'get_text', { session: 's-text' })
  assert.equal(frame.payload.data.mode, 'readable')
  assert.equal(frame.payload.data.text, 'Article body.\n\nMore prose.')
  assert.equal(frame.payload.data.truncated, false)
})

test('get_text raw mode keeps the navigation text', async () => {
  await callTool('83', 'navigate', { session: 's-text2', url: 'https://example.com' })
  const frame = await callTool('84', 'get_text', { session: 's-text2', raw: true })
  assert.equal(frame.payload.data.mode, 'raw')
  assert.match(frame.payload.data.text, /Nav Home About/)
})

test('get_text honours maxChars and flags truncation', async () => {
  await callTool('85', 'navigate', { session: 's-text3', url: 'https://example.com' })
  const frame = await callTool('86', 'get_text', { session: 's-text3', maxChars: 7 })
  assert.equal(frame.payload.data.text.length, 7)
  assert.equal(frame.payload.data.truncated, true)
})

test('hover activates the tab and dispatches a trusted mouseMoved', async () => {
  await callTool('87', 'navigate', { session: 's-hover', url: 'https://example.com' })
  const before = mock.activations.length
  const frame = await callTool('88', 'hover', { session: 's-hover', selector: '@e1' })
  assert.equal(frame.payload.data.trusted, true)
  // Centre of the mocked 1,2 3x4 box.
  assert.equal(frame.payload.data.x, 2.5)
  assert.ok(mock.activations.length > before, 'hover must activate its tab')
  const moved = mock.cdpCalls.filter((call) => call.method === 'Input.dispatchMouseEvent').pop()
  assert.equal(moved.params.type, 'mouseMoved')
  assert.equal(moved.params.buttons, 0)
})

test('hover at explicit coordinates needs no selector', async () => {
  await callTool('89', 'navigate', { session: 's-hover2', url: 'https://example.com' })
  const frame = await callTool('90', 'hover', { session: 's-hover2', x: 40, y: 60 })
  assert.equal(frame.payload.data.x, 40)
})

test('hover without a target explains what it needs', async () => {
  await callTool('91', 'navigate', { session: 's-hover3', url: 'https://example.com' })
  const frame = await callTool('92', 'hover', { session: 's-hover3' })
  assert.match(frame.payload.error, /selector, or both x and y/)
})

test('attaching enables the Network domain so requests can be recorded', async () => {
  await callTool('93', 'navigate', { session: 's-attach', url: 'https://example.com' })
  assert.ok(mock.cdpCalls.some((call) => call.method === 'Network.enable'))
})

test('find_tab attaches the borrowed tab so its network is recorded', async () => {
  const frame = await callTool('94', 'find_tab', { session: 's-borrow', active: true })
  assert.equal(frame.payload.data.borrowed, true)
  assert.ok(mock.cdpCalls.some((call) => call.method === 'Network.enable'))
})

test('network_detail reports a missing body as an outcome, not a failure', async () => {
  const opened = await callTool('95', 'navigate', { session: 's-nobody', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Network.requestWillBeSent', {
    requestId: 'gone-1', type: 'Document', request: { method: 'GET', url: 'https://example.com/gone', headers: {} },
  })
  mock.emit(tabId, 'Network.responseReceived', {
    requestId: 'gone-1', response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
  })
  // Chrome answers with a CDP error object rather than rejecting once it has
  // evicted the body; the tool must still return its headers.
  bodyAnswer = { code: -32000, message: 'No resource with given identifier found' }
  const frame = await callTool('96', 'network_detail', { session: 's-nobody', requestId: 'gone-1', body: true })
  bodyAnswer = null
  assert.equal(frame.payload.error, undefined, 'a missing body must not fail the call')
  // The message, not the envelope: a stringified {code,message} object would
  // still contain this substring, so assert equality and rule out raw JSON.
  assert.equal(frame.payload.data.bodyError, 'No resource with given identifier found')
  assert.ok(
    !frame.payload.data.bodyError.includes('{'),
    'bodyError must be a readable message, not stringified JSON',
  )
  assert.match(frame.payload.data.bodyHint, /only while the page is still loaded/)
  assert.equal(frame.payload.data.status, 200, 'headers survive a missing body')
})

test('navigate enables the Network domain BEFORE the page starts loading', async () => {
  // The regression this guards: attaching after waitForLoad still calls
  // Network.enable, but by then the document and every subresource have
  // already been requested, so the network log is silently always empty.
  mock.timeline.length = 0
  await callTool('97', 'navigate', { session: 's-order', url: 'https://example.com/first' })

  const enableAt = mock.timeline.findIndex((e) => e.kind === 'cdp' && e.method === 'Network.enable')
  const navigateAt = mock.timeline.findIndex(
    (e) => e.kind === 'tabs.navigate' && e.url === 'https://example.com/first',
  )
  assert.ok(enableAt >= 0, 'Network.enable must be sent')
  assert.ok(navigateAt >= 0, 'the tab must be pointed at the url via tabs.update')
  assert.ok(
    enableAt < navigateAt,
    `Network.enable (index ${enableAt}) must precede the navigation (index ${navigateAt})`,
  )

  // The tab is created blank for the same reason: a real url passed to
  // tabs.create would start loading before the debugger could attach. It must
  // be about:blank rather than nothing, because a url-less tab lands on
  // chrome://newtab, which the debugger refuses to attach to.
  const created = mock.timeline.find((e) => e.kind === 'tabs.create')
  assert.equal(created.url, 'about:blank', 'the tab must be created at about:blank')
})

test('navigating an existing session tab still records its next page', async () => {
  await callTool('98', 'navigate', { session: 's-reuse', url: 'https://example.com/one' })
  mock.timeline.length = 0
  await callTool('99', 'navigate', { session: 's-reuse', url: 'https://example.com/two' })
  const enableAt = mock.timeline.findIndex((e) => e.kind === 'cdp' && e.method === 'Network.enable')
  const navigateAt = mock.timeline.findIndex((e) => e.kind === 'tabs.navigate')
  // attach() is idempotent, so the second navigate may not re-enable; what
  // matters is that it never navigates an unattached tab.
  if (enableAt >= 0) assert.ok(enableAt < navigateAt, 'enable must precede navigation')
  assert.ok(navigateAt >= 0, 'the reused tab must be navigated')
})

test('network_detail keeps a rejected body error readable too', async () => {
  const opened = await callTool('100', 'navigate', { session: 's-reject', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Network.requestWillBeSent', {
    requestId: 'rej-1', type: 'Document', request: { method: 'GET', url: 'https://example.com/rej', headers: {} },
  })
  mock.emit(tabId, 'Network.responseReceived', {
    requestId: 'rej-1', response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
  })
  // chrome.debugger rejects as well as resolves with an error, and both paths
  // must produce a message rather than a stringified envelope.
  const failure = new Error('No resource with given identifier found')
  failure.code = -32000
  bodyAnswer = failure
  const frame = await callTool('101', 'network_detail', { session: 's-reject', requestId: 'rej-1', body: true })
  bodyAnswer = null
  assert.equal(frame.payload.error, undefined, 'a rejected body must not fail the call')
  assert.equal(frame.payload.data.bodyError, 'No resource with given identifier found')
  assert.ok(!frame.payload.data.bodyError.includes('{'), 'must not be stringified JSON')
  assert.equal(frame.payload.data.status, 200, 'headers survive')
})

test('a CDP error whose message is itself JSON is unwrapped to prose', async () => {
  const opened = await callTool('102', 'navigate', { session: 's-wrapped', url: 'https://example.com' })
  const tabId = opened.payload.data.tabId
  mock.emit(tabId, 'Network.requestWillBeSent', {
    requestId: 'wrap-1', type: 'Document', request: { method: 'GET', url: 'https://example.com/w', headers: {} },
  })
  mock.emit(tabId, 'Network.responseReceived', {
    requestId: 'wrap-1', response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
  })
  // This is the shape real Chrome uses: the Error's message IS the envelope.
  bodyAnswer = new Error('{"code":-32000,"message":"No resource with given identifier found"}')
  const frame = await callTool('103', 'network_detail', { session: 's-wrapped', requestId: 'wrap-1', body: true })
  bodyAnswer = null
  assert.equal(frame.payload.data.bodyError, 'No resource with given identifier found')
  assert.ok(!frame.payload.data.bodyError.includes('{'), 'the JSON envelope must be unwrapped')
})

// --- Capability upgrades: generic interaction, no library special-cases ----

test('click dispatches the full pointer stroke, not just click()', async () => {
  await callTool('110', 'navigate', { session: 's-click2', url: 'https://example.com' })
  const before = mock.cdpCalls.length
  const frame = await callTool('111', 'click', { session: 's-click2', selector: '#menu' })
  assert.equal(frame.payload.data.success, true)
  const evaluated = mock.cdpCalls
    .slice(before)
    .find((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('.click()'))
  assert.ok(evaluated, 'click must still end with click()')
  for (const stage of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    assert.ok(evaluated.params.expression.includes(stage), `the synthetic stroke must include ${stage}`)
  }
})

test('click trusted:true dispatches real input at the element center', async () => {
  await callTool('112', 'navigate', { session: 's-click3', url: 'https://example.com' })
  const before = mock.cdpCalls.length
  const frame = await callTool('113', 'click', { session: 's-click3', selector: '#pay', trusted: true })
  assert.equal(frame.payload.data.trusted, true)
  const mouse = mock.cdpCalls.slice(before).filter((call) => call.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(mouse.map((call) => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  // The staged box is x1 y2 w3 h4, so the center is (2.5, 4).
  assert.equal(mouse[1].params.x, 2.5)
  assert.equal(mouse[1].params.y, 4)
})

test('mouse_click accepts a selector and clicks its center', async () => {
  await callTool('114', 'navigate', { session: 's-mc2', url: 'https://example.com' })
  const before = mock.cdpCalls.length
  const frame = await callTool('115', 'mouse_click', { session: 's-mc2', selector: '@e1' })
  assert.equal(frame.payload.data.x, 2.5)
  assert.equal(frame.payload.data.y, 4)
  const pressed = mock.cdpCalls
    .slice(before)
    .find((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed')
  assert.equal(pressed.params.x, 2.5)
})

test('select drives an ARIA combobox through its popup', async () => {
  await callTool('116', 'navigate', { session: 's-aria', url: 'https://example.com' })
  inspectAnswer = { tag: 'input', role: 'combobox', haspopup: 'listbox' }
  dropdownAnswer = { options: [
    { ref: 'monthly', text: 'Monthly' },
    { ref: 'yearly', text: 'Yearly' },
  ] }
  ariaAfterAnswer = { expanded: 'false', display: 'Yearly' }
  const before = mock.cdpCalls.length
  const frame = await callTool('117', 'select', { session: 's-aria', selector: '#billing', value: 'Yearly' })
  inspectAnswer = dropdownAnswer = ariaAfterAnswer = null
  assert.equal(frame.payload.error, undefined, frame.payload.error)
  assert.equal(frame.payload.data.mode, 'custom')
  assert.equal(frame.payload.data.text, 'Yearly')
  assert.equal(frame.payload.data.verified, true)
  const presses = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed')
  assert.equal(presses.length, 2, 'one trusted click opens the popup, one chooses')
  assert.equal(presses[1].params.y, 4, 'the choosing click uses the option page ref safe point')
  const optionProbe = mock.cdpCalls.slice(before).find((call) =>
    call.method === 'Runtime.evaluate' && call.params.expression.includes('__dshChromeOptionRefs["yearly"]'))
  assert.ok(optionProbe, 'the matched option is re-resolved by temporary page identity')
})

test('select on a custom control that ignores ARIA names the fallback', async () => {
  await callTool('118', 'navigate', { session: 's-aria2', url: 'https://example.com' })
  inspectAnswer = { tag: 'div', role: '', haspopup: '' }
  const frame = await callTool('119', 'select', { session: 's-aria2', selector: '#fancy', value: 'x' })
  inspectAnswer = null
  assert.match(frame.payload.error, /not a <select> or an ARIA combobox/)
})

test('select reports the visible options when an ARIA popup has no match', async () => {
  await callTool('120', 'navigate', { session: 's-aria3', url: 'https://example.com' })
  inspectAnswer = { tag: 'input', role: 'combobox', haspopup: '' }
  dropdownAnswer = { options: [{ text: 'Monthly', x: 10, y: 10 }] }
  const before = mock.cdpCalls.length
  const frame = await callTool('121', 'select', { session: 's-aria3', selector: '#billing', value: 'Weekly' })
  inspectAnswer = dropdownAnswer = null
  assert.match(frame.payload.error, /no option matching "Weekly"/)
  assert.match(frame.payload.error, /Monthly/)
  const escapes = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Escape')
  assert.ok(escapes.length >= 1, 'the popup this call opened is closed again')
})

test('fill reads the value back and reports verified', async () => {
  await callTool('122', 'navigate', { session: 's-fill2', url: 'https://example.com' })
  fillAnswer = { tag: 'input', mode: 'value', value: 'hello', verified: true }
  const frame = await callTool('123', 'fill', { session: 's-fill2', selector: '#q', value: 'hello' })
  fillAnswer = null
  assert.equal(frame.payload.data.verified, true)
  assert.equal(frame.payload.data.value, 'hello')
})

test('fill refuses a readonly dropdown input and points at select', async () => {
  await callTool('124', 'navigate', { session: 's-fill3', url: 'https://example.com' })
  fillAnswer = { error: 'not-editable', tag: 'input', state: 'readonly', combobox: true }
  const frame = await callTool('125', 'fill', { session: 's-fill3', selector: '#combo', value: 'x' })
  fillAnswer = null
  assert.match(frame.payload.error, /readonly/)
  assert.match(frame.payload.error, /use select instead/)
})

test('a stale @e ref names itself and the fix, after one retry', async () => {
  await callTool('126', 'navigate', { session: 's-stale', url: 'https://example.com' })
  boxAnswer = null
  const before = mock.cdpCalls.length
  const frame = await callTool('127', 'scroll_into_view', { session: 's-stale', selector: '@e77' })
  boxAnswer = undefined
  assert.match(frame.payload.error, /stale ref @e77/)
  assert.match(frame.payload.error, /take a new snapshot/)
  const resolves = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('__dshChromeRefs[77]'))
  assert.equal(resolves.length, 2, 'the resolution must retry once before failing')
})

test('a missing CSS selector reports the page it searched', async () => {
  await callTool('128', 'navigate', { session: 's-miss', url: 'https://example.com' })
  boxAnswer = null
  const frame = await callTool('129', 'scroll_into_view', { session: 's-miss', selector: '#gone' })
  boxAnswer = undefined
  assert.match(frame.payload.error, /no element matches #gone/)
  assert.match(frame.payload.error, /page:/)
})

test('trusted keystrokes re-aim at the remembered element even on an active tab', async () => {
  await callTool('130', 'navigate', { session: 's-aim', url: 'https://example.com' })
  activeAnswer = true
  const before = mock.cdpCalls.length
  await callTool('131', 'send_keys', { session: 's-aim', keys: 'Enter' })
  activeAnswer = false
  const restored = mock.cdpCalls
    .slice(before)
    .find((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('__dshChromeFocused'))
  assert.ok(restored, 'the focus restore must run even when the tab is already active')
})

test('a session reuses one tab group across newTab navigations', async () => {
  mock.groupCalls.length = 0
  await callTool('132', 'navigate', { session: 's-group', url: 'https://example.com/a' })
  await callTool('133', 'navigate', { session: 's-group', url: 'https://example.com/b', newTab: true })
  assert.equal(mock.groupCalls.length, 2)
  assert.equal(mock.groupCalls[0].groupId, undefined, 'the first tab founds the group')
  assert.equal(mock.groupCalls[1].groupId, 7, 'the second tab joins the same group')
})

test('list_tabs reports every tab in the session group, flagging the current one', async () => {
  await callTool('134', 'navigate', { session: 's-list', url: 'https://example.com/one' })
  const frame = await callTool('135', 'list_tabs', { session: 's-list' })
  const tabs = frame.payload.data.tabs
  const member = tabs.find((tab) => tab.tabId === 100)
  assert.ok(member, 'group members are listed even when not current')
  assert.equal(member.current, false)
})

test('snapshot scoped to a selector renders only that subtree', async () => {
  await callTool('136', 'navigate', { session: 's-scope', url: 'https://example.com' })
  const frame = await callTool('137', 'snapshot', { session: 's-scope', selector: '#panel' })
  assert.equal(frame.payload.error, undefined, frame.payload.error)
  assert.match(frame.payload.data.tree, /@e42 link "More"/)
  assert.doesNotMatch(frame.payload.data.tree, /checkbox/, 'nodes outside the scoped subtree are absent')
})


test('select walks an aria-activedescendant combobox with the keyboard', async () => {
  await callTool('140', 'navigate', { session: 's-kbd', url: 'https://example.com' })
  inspectAnswer = { tag: 'input', role: 'combobox', haspopup: 'listbox' }
  // The popup opens but renders no clickable [role="option"]: the visible list
  // is presentation-only and the active option is named on the combobox.
  dropdownAnswer = { options: [], opened: true }
  activeAnswers = [
    { activeId: 'g_list_0', text: 'male' },
    { activeId: 'g_list_1', text: 'female' },
  ]
  ariaAfterAnswer = { expanded: 'false', display: 'Female' }
  const before = mock.cdpCalls.length
  const frame = await callTool('141', 'select', { session: 's-kbd', selector: '#gender', value: 'Female' })
  inspectAnswer = dropdownAnswer = ariaAfterAnswer = null
  activeAnswers = []
  assert.equal(frame.payload.error, undefined, frame.payload.error)
  assert.equal(frame.payload.data.mode, 'custom')
  assert.equal(frame.payload.data.text, 'female')
  assert.equal(frame.payload.data.verified, true)
  const keys = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'rawKeyDown')
    .map((call) => call.params.key)
  assert.deepEqual(keys, ['ArrowDown', 'Enter'], 'one step to female, then commit')
})

test('the keyboard walk reports the whole cycle when nothing matches', async () => {
  await callTool('142', 'navigate', { session: 's-kbd2', url: 'https://example.com' })
  inspectAnswer = { tag: 'input', role: 'combobox', haspopup: '' }
  dropdownAnswer = { options: [], opened: true }
  activeAnswers = [
    { activeId: 'o1', text: 'monthly' },
    { activeId: 'o2', text: 'daily' },
    { activeId: 'o1', text: 'monthly' },
  ]
  const before = mock.cdpCalls.length
  const frame = await callTool('143', 'select', { session: 's-kbd2', selector: '#period', value: 'Weekly' })
  inspectAnswer = dropdownAnswer = null
  activeAnswers = []
  assert.match(frame.payload.error, /no option matching "Weekly"/)
  assert.match(frame.payload.error, /monthly \| daily/)
  const escapes = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Escape')
  assert.ok(escapes.length >= 1, 'the popup is closed before reporting failure')
})




test('trusted click rejects a zero-size target before pressing', async () => {
  await callTool('160', 'navigate', { session: 's-zero', url: 'https://example.com' })
  safeClickAnswers = [{ error: 'zero-size' }]
  const before = mock.cdpCalls.length
  const frame = await callTool('161', 'click', { session: 's-zero', selector: '#zero', trusted: true })
  assert.match(frame.payload.error, /zero-size/)
  assert.equal(mock.cdpCalls.slice(before).some((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'), false)
})

test('trusted click rejects an obscured target before pressing', async () => {
  await callTool('162', 'navigate', { session: 's-covered', url: 'https://example.com' })
  safeClickAnswers = [{ error: 'obscured' }]
  const before = mock.cdpCalls.length
  const frame = await callTool('163', 'click', { session: 's-covered', selector: '#covered', trusted: true })
  assert.match(frame.payload.error, /obscured/)
  assert.equal(mock.cdpCalls.slice(before).some((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'), false)
})

test('trusted click revalidates after activation and mouse movement', async () => {
  await callTool('164', 'navigate', { session: 's-reflow', url: 'https://example.com' })
  safeClickAnswers = [{ x: 10, y: 20 }, { x: 30, y: 40 }]
  const before = mock.cdpCalls.length
  const frame = await callTool('165', 'click', { session: 's-reflow', selector: '#moves', trusted: true })
  assert.equal(frame.payload.data.x, 30)
  const mouse = mock.cdpCalls.slice(before).filter((c) => c.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(mouse.map((c) => [c.params.type, c.params.x, c.params.y]), [
    ['mouseMoved', 10, 20], ['mousePressed', 30, 40], ['mouseReleased', 30, 40],
  ])
})

test('raw trusted click rejects non-finite and off-viewport coordinates', async () => {
  await callTool('170', 'navigate', { session: 's-coordinates', url: 'https://example.com' })
  const nonFinite = await callTool('171', 'mouse_click', { session: 's-coordinates', x: null, y: 2 })
  assert.match(nonFinite.payload.error, /finite numbers/)
  const outside = await callTool('172', 'mouse_click', { session: 's-coordinates', x: 1280, y: 2 })
  assert.match(outside.payload.error, /outside viewport 1280x720/)
})

test('safe click failure includes the hit target summary', async () => {
  await callTool('173', 'navigate', { session: 's-hit-summary', url: 'https://example.com' })
  safeClickAnswers = [{ error: 'obscured', hit: 'div#overlay' }]
  const frame = await callTool('174', 'click', { session: 's-hit-summary', selector: '#pay', trusted: true })
  assert.match(frame.payload.error, /hit target: div#overlay/)
})

test('trusted click uses the CDP button bitmask', async () => {
  await callTool('166', 'navigate', { session: 's-button-mask', url: 'https://example.com' })
  const before = mock.cdpCalls.length
  await callTool('167', 'mouse_click', { session: 's-button-mask', x: 8, y: 9, button: 'right' })
  const stroke = mock.cdpCalls.slice(before).filter((c) => c.method === 'Input.dispatchMouseEvent')
  assert.equal(stroke.find((c) => c.params.type === 'mousePressed').params.buttons, 2)
  assert.equal(stroke.find((c) => c.params.type === 'mouseReleased').params.buttons, 0)
})

test('ARIA dropdown already open is not blindly clicked again', async () => {
  await callTool('168', 'navigate', { session: 's-open-dropdown', url: 'https://example.com' })
  inspectAnswer = { tag: 'input', role: 'combobox', haspopup: 'listbox' }
  dropdownInitiallyOpen = true
  dropdownAnswer = { options: [{ ref: 'yearly-open', text: 'Yearly' }], opened: true }
  ariaAfterAnswer = { expanded: 'false', display: 'Yearly' }
  const before = mock.cdpCalls.length
  const frame = await callTool('169', 'select', { session: 's-open-dropdown', selector: '#billing', value: 'Yearly' })
  inspectAnswer = dropdownAnswer = ariaAfterAnswer = null
  dropdownInitiallyOpen = false
  assert.equal(frame.payload.error, undefined, frame.payload.error)
  const presses = mock.cdpCalls.slice(before).filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed')
  assert.equal(presses.length, 1, 'only the option is clicked when popup is already open')
})

test('trusted clicks do not pre-focus the remembered element', async () => {
  // Comboboxes suppress a click that lands right after a programmatic focus
  // (the focus+click double-toggle guard), so the mouse path must not run the
  // keyboard path's focus restore.
  await callTool('150', 'navigate', { session: 's-nofocus', url: 'https://example.com' })
  const before = mock.cdpCalls.length
  await callTool('151', 'mouse_click', { session: 's-nofocus', x: 5, y: 6 })
  const restores = mock.cdpCalls
    .slice(before)
    .filter((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('__dshChromeFocused'))
  assert.equal(restores.length, 0, 'a click must arrive without a programmatic focus before it')
})
