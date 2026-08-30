/**
 * DSH Chrome Bridge service worker.
 *
 * Connects out to the DSH web server's /chrome/ws bridge endpoint over
 * WebSocket and executes the tool calls it forwards. All page work goes
 * through the Chrome DevTools Protocol via chrome.debugger, which is what
 * makes trusted input (real mouse and key events) possible.
 *
 * The socket address follows the same "DSH server" setting the rest of the
 * extension uses (settings.js's codemax_dsh_backend_url), so configuring one
 * URL configures everything; dsh_chrome_url remains as an explicit override.
 *
 * MV3 service workers are evicted aggressively, so the socket cannot simply be
 * opened once at startup: an alarm re-checks the desired state every 30s and
 * reconnects when needed.
 */

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3080'
const BRIDGE_WS_PATH = '/chrome/ws'
// The bridge runs as a standalone Rust daemon on its own fixed port, so the WS
// URL no longer follows the dsh-web backend URL. `dsh_chrome_url` is the explicit
// override; the default points straight at the daemon.
const DEFAULT_BRIDGE_WS_URL = `ws://127.0.0.1:37086${BRIDGE_WS_PATH}`
const RECONCILE_ALARM = 'dsh-chrome-reconcile'
const STORAGE = {
  enabled: 'dsh_chrome_enabled',
  url: 'dsh_chrome_url',
  // Shared with src/platform/storage/settings.js — the extension-wide DSH
  // server address. Read directly because this file must stay import-free.
  backendUrl: 'codemax_dsh_backend_url',
}
const CDP_VERSION = '1.3'

/** Tabs this bridge opened, keyed by session name. */
const sessionTabs = new Map()
/**
 * Tab group each session's tabs collect into, keyed by session name.
 *
 * Remembered so a later navigate({newTab}) joins the same group instead of
 * founding a new one per tab, which scattered one task across many groups.
 */
const sessionGroups = new Map()
/** Tabs currently attached to the debugger. */
const attached = new Set()

// ---------------------------------------------------------------- desired state

/** Derive the bridge socket URL from a DSH server base URL (http→ws, https→wss). */
function bridgeUrlFrom(backendUrl) {
  try {
    const parsed = new URL(backendUrl)
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${BRIDGE_WS_PATH}`
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return `ws://127.0.0.1:3080${BRIDGE_WS_PATH}`
  }
}

async function getDesired() {
  const stored = await chrome.storage.local.get([STORAGE.enabled, STORAGE.url, STORAGE.backendUrl])
  return {
    enabled: stored[STORAGE.enabled] !== false,
    // An explicit socket override wins; otherwise the bridge connects to the
    // standalone daemon on its fixed port (the backend URL drives only the
    // native-host autostart of dsh web, not the WS connection).
    url: stored[STORAGE.url] || DEFAULT_BRIDGE_WS_URL,
  }
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ [STORAGE.enabled]: enabled })
  if (enabled) reconcile()
  else teardown()
}

// ---------------------------------------------------------------- network log

/** Most requests remembered per tab; oldest are dropped past this. */
const NETWORK_LIMIT = 200

/** tabId -> { entries: [], dropped: number } */
const networkLog = new Map()

/** tabId -> the dialog currently blocking that tab, or absent when none. */
const pendingDialogs = new Map()

/**
 * tabId -> the rows the last snapshot of that tab produced.
 *
 * The baseline `snapshot({ diff: true })` compares against. Held per tab and
 * dropped with the rest of a tab's state, because the service worker outlives
 * any individual tab.
 */
const lastSnapshots = new Map()

/**
 * Drop everything remembered about a tab.
 *
 * The service worker outlives individual tabs, so a log that is never pruned
 * would grow for the life of the browser session.
 */
function forgetTabState(tabId) {
  networkLog.delete(tabId)
  pendingDialogs.delete(tabId)
  lastSnapshots.delete(tabId)
}

function networkEntries(tabId) {
  let log = networkLog.get(tabId)
  if (!log) {
    log = { entries: [], dropped: 0 }
    networkLog.set(tabId, log)
  }
  return log
}

/**
 * Accumulate network and dialog events.
 *
 * Both features are event-driven rather than request/response: a network record
 * is assembled from a requestWillBeSent and a later responseReceived naming the
 * same requestId, and a dialog can only be answered once Chrome has told us one
 * is open. So the worker listens continuously and the tools read this state.
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId == null || !attached.has(tabId)) return

  switch (method) {
    case 'Network.requestWillBeSent': {
      const log = networkEntries(tabId)
      log.entries.push({
        requestId: params.requestId,
        method: params.request?.method || 'GET',
        url: params.request?.url || '',
        resourceType: params.type || '',
        requestHeaders: params.request?.headers || {},
        startedAt: params.wallTime,
        status: null,
      })
      while (log.entries.length > NETWORK_LIMIT) {
        log.entries.shift()
        log.dropped += 1
      }
      break
    }
    case 'Network.responseReceived': {
      const entry = networkEntries(tabId).entries.find(
        (candidate) => candidate.requestId === params.requestId,
      )
      if (entry) {
        entry.status = params.response?.status ?? null
        entry.statusText = params.response?.statusText || ''
        entry.mimeType = params.response?.mimeType || ''
        entry.responseHeaders = params.response?.headers || {}
      }
      break
    }
    case 'Network.loadingFailed': {
      const entry = networkEntries(tabId).entries.find(
        (candidate) => candidate.requestId === params.requestId,
      )
      if (entry) entry.failed = params.errorText || 'failed'
      break
    }
    case 'Page.javascriptDialogOpening':
      pendingDialogs.set(tabId, {
        type: params.type || 'alert',
        message: params.message || '',
        defaultPrompt: params.defaultPrompt || '',
      })
      break
    case 'Page.javascriptDialogClosed':
      pendingDialogs.delete(tabId)
      break
    default:
      break
  }
})

// ---------------------------------------------------------------- CDP plumbing

/** Attach the debugger to a tab once, and remember that we did. */
async function attach(tabId) {
  if (attached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, CDP_VERSION)
  attached.add(tabId)
  // Page and DOM are needed for navigation and screenshots. Accessibility must
  // be enabled explicitly: without it getFullAXTree answers with a bare stub
  // root and none of the page's real nodes.
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable')
  await chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable')
  // Network powers the network/network_detail tools. It must be enabled before
  // the requests we want to report are made, which is why it happens here at
  // attach time rather than lazily inside the tool.
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable')
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  forgetTabState(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // The tab may already be gone; nothing to release.
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId)
    forgetTabState(source.tabId)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  forgetTabState(tabId)
  for (const [session, id] of sessionTabs) {
    if (id === tabId) sessionTabs.delete(session)
  }
})

/**
 * Pull the human-readable message out of a CDP failure.
 *
 * chrome.debugger surfaces an error in several shapes depending on whether it
 * rejected or resolved: an Error, a bare `{code, message}`, or a nested
 * `{error: {message}}`. Stringifying the envelope would hand the model raw
 * JSON, so callers use this instead.
 */
function cdpErrorMessage(failure, fallback = 'CDP command failed') {
  if (!failure) return fallback
  const direct =
    typeof failure === 'string'
      ? failure
      : (typeof failure.error === 'object' ? failure.error?.message : failure.error) ||
        failure.message ||
        ''
  const text = String(direct || fallback).trim()
  // Chrome frequently rejects with an Error whose *message is itself* the JSON
  // envelope, e.g. Error('{"code":-32000,"message":"No resource ..."}'). Unwrap
  // one level of that so the model reads prose instead of a serialized object.
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text)
      const inner =
        (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) || parsed.message
      if (inner) return String(inner)
    } catch {
      // Not JSON after all; fall through and return the text as-is.
    }
  }
  return text
}

/** Send one CDP command to a tab. */
async function cdp(tabId, method, params = {}) {
  await attach(tabId)
  return chrome.debugger.sendCommand({ tabId }, method, params)
}

/**
 * Bring a tab to the foreground.
 *
 * Chrome delivers synthesized *trusted* input only to the focused tab of a
 * focused window: dispatching `Input.*` at a background tab is accepted by the
 * protocol and then silently dropped. Tools that rely on trusted input must
 * therefore activate their tab first, unlike the DOM-level tools which work
 * perfectly well on a hidden tab.
 */
async function focusTab(tabId, { restoreFocus = true } = {}) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true })
    if (tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true })
      } catch {
        // A window that cannot be focused (minimized by the user) still gets the
        // tab activation, which is the part that matters most.
      }
    }
  }

  // Keyboard callers only: a trusted CLICK establishes its own focus, and
  // pre-focusing its target actually breaks widgets that suppress the click
  // right after a programmatic focus (the standard focus+click double-toggle
  // guard comboboxes use).
  if (!restoreFocus) return

  // Activating a tab moves DOM focus back to the document body. A caller who
  // just filled or clicked a field expects the next keystroke to land there, so
  // restore the element the page had focused. This runs even when the tab was
  // already active: activation is only one way focus drifts to the body — the
  // page itself may have blurred the element since focus() ran, and skipping
  // the restore on an active tab silently sent every keystroke to <body>.
  try {
    await evaluateInPage(
      tabId,
      `(() => {
        const el = globalThis.__dshChromeFocused;
        if (el && el.isConnected && typeof el.focus === 'function') el.focus();
        return true;
      })()`,
    )
  } catch {
    // Focus restoration is best effort; the key still reaches the document.
  }
}

/** Evaluate an expression in the page and return its unwrapped value. */
async function evaluateInPage(tabId, expression, { awaitPromise = true } = {}) {
  const response = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  })
  if (response?.exceptionDetails) {
    const text =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      'evaluation failed'
    throw new Error(text)
  }
  return response?.result?.value
}

// ---------------------------------------------------------------- tab helpers

/** The tab a session is currently acting on. */
function currentTab(session) {
  const tabId = sessionTabs.get(session)
  if (tabId == null) {
    throw new Error(
      `session "${session}" has no tab yet — call navigate (or find_tab) first`,
    )
  }
  return tabId
}

/** Put a tab into the session's tab group so the user sees one group per task. */
async function groupTab(session, tabId, groupTitle) {
  try {
    const existing = sessionGroups.get(session)
    if (existing != null) {
      try {
        // Join the group the session already owns, so a task's tabs stay
        // together instead of founding one group per tab.
        await chrome.tabs.group({ tabIds: [tabId], groupId: existing })
        if (groupTitle) await chrome.tabGroups.update(existing, { title: groupTitle })
        return
      } catch {
        // The user closed that group; fall through and start a fresh one.
      }
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] })
    sessionGroups.set(session, groupId)
    await chrome.tabGroups.update(groupId, {
      title: groupTitle || session,
    })
  } catch {
    // Grouping is a convenience; losing it must not fail the tool call.
  }
}

// ---------------------------------------------------------------- selectors

/**
 * Resolve a selector to a page-side element expression.
 *
 * An `@eN` ref names an entry in the table the last snapshot published, keyed by
 * backend node id. `find` writes into the same table under its own keys, so
 * both kinds of ref resolve through one lookup.
 */
function elementExpression(selector) {
  if (/^@e\d+$/.test(selector)) {
    const key = Number(selector.slice(2))
    return `(globalThis.__dshChromeRefs && globalThis.__dshChromeRefs[${key}])`
  }
  if (/^@option:[a-z0-9]+$/.test(selector)) {
    const key = selector.slice(8)
    return `(globalThis.__dshChromeOptionRefs && globalThis.__dshChromeOptionRefs[${JSON.stringify(key)}])`
  }
  return `document.querySelector(${JSON.stringify(selector)})`
}

/**
 * How long a failed element resolution waits before its one retry.
 *
 * A framework re-render replaces DOM nodes in a burst: a selector that resolves
 * to nothing right now usually resolves again a frame later. One short retry
 * absorbs that race; anything longer belongs to wait_for_selector.
 */
const RESOLVE_RETRY_MS = 150

/** The error a selector that resolves to nothing produces, with what to do next. */
async function missingElementMessage(tabId, selector) {
  if (/^@e\d+$/.test(selector)) {
    return `stale ref ${selector} — the page re-rendered since it was issued; take a new snapshot (or find) and use the fresh ref`
  }
  let context = ''
  try {
    const info = await evaluateInPage(tabId, `location.href + ' [' + document.readyState + ']'`)
    context = ` (page: ${info})`
  } catch {
    // Purely diagnostic; the main message stands on its own.
  }
  return `no element matches ${selector}${context}`
}

/**
 * Resolve `selector` in the page and run `body` with the element bound to `el`.
 *
 * The single resolution path every element tool goes through: it retries once
 * when the element is missing (a framework re-render replaces nodes mid-call),
 * and the failure it throws tells a stale @e ref apart from a wrong selector.
 */
async function runOnElement(tabId, selector, body, values = {}) {
  const declarations = Object.entries(values)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
    .join('\n')
  const expression = `(() => {
    const el = ${elementExpression(selector)};
    if (!el) return null;
    ${declarations}
    ${body}
  })()`
  let result = await evaluateInPage(tabId, expression)
  if (result == null) {
    await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_MS))
    result = await evaluateInPage(tabId, expression)
  }
  if (result == null) throw new Error(await missingElementMessage(tabId, selector))
  return result
}

/**
 * Click at viewport coordinates with trusted CDP input.
 *
 * A mouseMoved goes first because hover-sensitive widgets arm themselves on
 * pointer arrival; a press landing with no preceding movement is a sequence no
 * real user produces.
 */
function mouseButtonBit(button) {
  return ({ left: 1, right: 2, middle: 4, back: 8, forward: 16 })[button] || 0
}

async function trustedClick(tabId, x, y, { button = 'left', clickCount = 1, selector } = {}) {
  await focusTab(tabId, { restoreFocus: false })
  let point = { x, y }
  if (selector) point = await safeClickPoint(tabId, selector)
  else if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be finite numbers')
  else {
    const viewport = await evaluateInPage(tabId, '({ width: innerWidth, height: innerHeight })')
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`coordinates (${x}, ${y}) are outside viewport ${viewport.width}x${viewport.height}`)
    }
  }
  const buttons = mouseButtonBit(button)
  if (!buttons) throw new Error(`unsupported mouse button: ${button}`)
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  if (selector) point = await safeClickPoint(tabId, selector, { scroll: false })
  const common = { x: point.x, y: point.y, button, clickCount, buttons }
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...common, type: 'mousePressed' })
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', buttons: 0 })
  return point
}

async function safeClickPoint(tabId, selector, { scroll = true } = {}) {
  const result = await runOnElement(tabId, selector, `
    const original = el;
    const summary = (node) => !node ? 'none' : [
      node.tagName ? node.tagName.toLowerCase() : node.nodeName,
      node.id ? '#' + node.id : '',
      node.getAttribute && node.getAttribute('role') ? '[role="' + node.getAttribute('role') + '"]' : '',
    ].join('');
    const visibleRects = (node) => Array.from(node.getClientRects()).map((r) => ({
      left: Math.max(0, r.left), top: Math.max(0, r.top),
      right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom),
    })).filter((r) => r.right > r.left && r.bottom > r.top);
    const usable = (node) => {
      if (!node || !node.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
      for (let cur = node; cur && cur.nodeType === 1; cur = cur.parentElement) {
        const style = getComputedStyle(cur);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.pointerEvents === 'none') return false;
      }
      return visibleRects(node).length > 0;
    };
    if (!original.isConnected) return { error: 'stale', hit: 'none' };
    if (${scroll}) original.scrollIntoView({ block: 'center', inline: 'center' });
    if (!original.isConnected) return { error: 'stale', hit: 'none' };
    if (original.disabled || original.getAttribute('aria-disabled') === 'true') return { error: 'disabled', hit: summary(original) };
    let target = original;
    if (!usable(target)) {
      target = null;
      for (let node = original.parentElement; node; node = node.parentElement) {
        if (!usable(node)) continue;
        const role = node.getAttribute('role');
        if (node.matches('button, a[href], input, select, textarea, summary, label, [tabindex], [contenteditable="true"], [role]') || role) {
          target = node;
          break;
        }
      }
      if (!target) return { error: 'zero-size-or-hidden', hit: summary(document.elementFromPoint(0, 0)) };
    }
    let lastHit = null;
    for (const r of visibleRects(target)) {
      const points = [
        [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
        [r.left + (r.right - r.left) * .2, r.top + (r.bottom - r.top) * .2],
        [r.left + (r.right - r.left) * .8, r.top + (r.bottom - r.top) * .2],
        [r.left + (r.right - r.left) * .2, r.top + (r.bottom - r.top) * .8],
        [r.left + (r.right - r.left) * .8, r.top + (r.bottom - r.top) * .8],
      ];
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y);
        lastHit = hit;
        if (hit && (hit === target || target.contains(hit))) {
          return { x, y, target: summary(original), proxy: target === original ? '' : summary(target), hit: summary(hit) };
        }
      }
    }
    return { error: 'obscured', hit: summary(lastHit), target: summary(original), proxy: target === original ? '' : summary(target) };
  `)
  if (result.error) {
    if (result.error === 'stale' && /^@e\d+$/.test(selector)) throw new Error(await missingElementMessage(tabId, selector))
    throw new Error(`cannot safely click ${selector}: ${result.error}; hit target: ${result.hit || 'none'}`)
  }
  return result
}

// ---------------------------------------------------------------- tools

/**
 * Schemes the debugger can never attach to. Opening such a page still works —
 * the tab navigates for real — but every CDP-powered tool (snapshot, click,
 * network, screenshot) is unavailable on it, because chrome.debugger refuses
 * to touch privileged browser UI.
 */
const PRIVILEGED_URL = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|edge-extension|view-source):/i

/** Whether the debugger has any chance of attaching to a page at this URL. */
function isDebuggableTarget(url) {
  return !PRIVILEGED_URL.test(url)
}

const tools = {
  async navigate({ session, url, newTab, group_title: groupTitle }) {
    // Accept any URL the browser can open, not just http(s): file:, about:,
    // data:, blob: and internal schemes like chrome: are all valid navigation
    // targets. chrome.tabs.update validates the rest, and its rejection is
    // surfaced verbatim to the caller.
    const target = typeof url === 'string' ? url.trim() : ''
    if (!target) {
      throw new Error('url is required')
    }
    let tabId = sessionTabs.get(session)
    if (newTab || tabId == null) {
      // Open the tab at about:blank and attach *before* pointing it at the
      // URL. The Network domain only reports requests issued after it is
      // enabled, so attaching after the navigation would miss the document
      // itself and every subresource it triggers. about:blank is deliberate:
      // a tab created with no url lands on chrome://newtab, and the debugger
      // cannot attach to a chrome:// page.
      const created = await chrome.tabs.create({ url: 'about:blank', active: false })
      tabId = created.id
      sessionTabs.set(session, tabId)
      await groupTab(session, tabId, groupTitle)
      // about:blank is always debuggable, so this attach cannot fail for a
      // legitimate reason; tolerate it anyway so a privileged target (where the
      // debugger detaches on navigation) still opens.
      try {
        await attach(tabId)
      } catch {
        // Opening the privileged page still proceeds; only CDP tools are lost.
      }
      await chrome.tabs.update(tabId, { url: target })
    } else {
      // An existing session tab is usually already attached, but navigating
      // from a privileged page (a prior chrome:// navigate) makes the debugger
      // refuse. Navigate first, then re-attach the debuggable target, so a
      // privileged origin cannot block an otherwise ordinary navigation.
      let attachedNow = false
      try {
        await attach(tabId)
        attachedNow = true
      } catch {
        // Current page is not debuggable (chrome://, etc.). Re-attach below.
      }
      await chrome.tabs.update(tabId, { url: target })
      if (!attachedNow && isDebuggableTarget(target)) {
        try {
          await attach(tabId)
        } catch {
          // e.g. a file: target without "Allow access to file URLs".
        }
      }
    }
    await waitForLoad(tabId)
    const tab = await chrome.tabs.get(tabId)
    return { success: true, url: tab.url, tabId }
  },

  async find_tab({ session, url, active }) {
    if (active) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!tab) throw new Error('no active tab to borrow')
      sessionTabs.set(session, tab.id)
      // Same reason as navigate: start recording network traffic immediately,
      // rather than from whenever the first page tool happens to attach.
      await attach(tab.id)
      return { success: true, url: tab.url, tabId: tab.id, borrowed: true }
    }
    if (!url) throw new Error('pass url, or active:true to borrow the visible tab')
    const tabs = await chrome.tabs.query({})
    const match = tabs.find((tab) => tab.url === url) || tabs.find((tab) => tab.url?.startsWith(url))
    if (!match) throw new Error(`no tab matching ${url} in this session`)
    sessionTabs.set(session, match.id)
    await attach(match.id)
    return { success: true, url: match.url, tabId: match.id, borrowed: false }
  },

  async list_tabs({ session }) {
    const tabId = sessionTabs.get(session)
    const groupId = sessionGroups.get(session)
    const tabs = []
    for (const tab of await chrome.tabs.query({})) {
      const grouped = groupId != null && tab.groupId === groupId
      if (tab.id !== tabId && !grouped && !isSessionTab(session, tab.id)) continue
      let groupTitle = ''
      if (tab.groupId != null && tab.groupId !== -1) {
        try {
          groupTitle = (await chrome.tabGroups.get(tab.groupId))?.title || ''
        } catch {
          groupTitle = ''
        }
      }
      tabs.push({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        groupTitle,
        // The tab page tools currently act on; siblings need find_tab first.
        current: tab.id === tabId,
      })
    }
    return { success: true, tabs }
  },

  async close_tab({ session }) {
    const tabId = currentTab(session)
    await detach(tabId)
    await chrome.tabs.remove(tabId)
    sessionTabs.delete(session)
    return { success: true, closed: true }
  },

  async close_session({ session }) {
    const tabId = sessionTabs.get(session)
    let groupId = sessionGroups.get(session)
    if (tabId == null && groupId == null) return { success: true, closed: 0 }
    let ids = tabId != null ? [tabId] : []
    try {
      if (groupId == null && tabId != null) {
        const tab = await chrome.tabs.get(tabId)
        if (tab.groupId != null && tab.groupId !== -1) groupId = tab.groupId
      }
      if (groupId != null) {
        const grouped = await chrome.tabs.query({ groupId })
        if (grouped.length) ids = grouped.map((entry) => entry.id)
      }
    } catch {
      // Fall back to just the tracked tab.
    }
    for (const id of ids) await detach(id)
    if (ids.length) await chrome.tabs.remove(ids)
    sessionTabs.delete(session)
    sessionGroups.delete(session)
    return { success: true, closed: ids.length }
  },

  async snapshot({ session, mode, maxDepth, diff, selector }) {
    const tabId = currentTab(session)
    const chosen = SNAPSHOT_MODES.has(mode) ? mode : 'interactive'
    const depth = Number.isFinite(maxDepth) ? Number(maxDepth) : -1

    // A scoped snapshot renders one container's subtree, so a huge page's
    // budget is spent on the part the caller cares about.
    const rootBackendId = selector ? await backendNodeId(tabId, selector) : null

    const nodes = await fetchAxNodes(tabId)
    const tree = buildAxTree(nodes, { mode: chosen, maxDepth: depth, rootBackendId })
    if (selector && !tree.rows.length) {
      throw new Error(
        `${selector} resolved but contains no accessible content in mode "${chosen}"; retry without selector or with mode "full"`,
      )
    }

    // Publish the refs the tree advertises so click/fill can resolve @eN.
    await publishRefs(tabId, tree.backendIds)

    let outputRows = tree.rows
    let removed = []
    if (diff) ({ rows: outputRows, removed } = diffRows(lastSnapshots.get(tabId), tree.rows))
    // Keep the complete current tree as the next baseline even though a diff
    // response contains only rows that were added or changed.
    lastSnapshots.set(tabId, tree.rows)

    // Apply the token budget to the actual response, not the complete tree.
    const rendered = formatSnapshot(outputRows)
    let text = rendered.text
    if (removed.length) {
      text = `${text}${text ? '\n' : ''}# removed: ${removed.join(' ')}`
    }

    const tab = await chrome.tabs.get(tabId)
    return {
      url: tab.url,
      title: tab.title,
      mode: chosen,
      nodeCount: rendered.kept,
      truncated: rendered.truncated,
      tree: text,
    }
  },

  async click({ session, selector, trusted }) {
    const tabId = currentTab(session)
    if (trusted) {
      // Real CDP input for pages that check isTrusted or listen outside the
      // DOM event path. Costs a tab activation, so it is opt-in.
      const point = await trustedClick(tabId, undefined, undefined, { selector })
      return { success: true, x: point.x, y: point.y, trusted: true }
    }
    const result = await runOnElement(
      tabId,
      selector,
      `el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const at = {
          bubbles: true, cancelable: true, composed: true, view: globalThis,
          button: 0, buttons: 1,
          clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        };
        const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        // A real click is a sequence, not one event: widgets commonly commit on
        // pointerdown or mousedown (dropdown triggers, drag handles), so a bare
        // click() never reaches them. Dispatch the full stroke in device order.
        el.dispatchEvent(new PointerEvent('pointerdown', pointer));
        el.dispatchEvent(new MouseEvent('mousedown', at));
        if (typeof el.focus === 'function') el.focus();
        el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
        el.click();
        // Remembered so a later trusted keystroke can be aimed back here even
        // if activating the tab resets document focus.
        globalThis.__dshChromeFocused = el;
        return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 120) };`,
    )
    return { success: true, ...result }
  },

  async fill({ session, selector, value }) {
    const tabId = currentTab(session)
    const result = await runOnElement(
      tabId,
      selector,
      `el.scrollIntoView({ block: 'center', inline: 'center' });
        const text = ${JSON.stringify(String(value ?? ''))};
        if (el.isContentEditable) {
          el.focus();
          globalThis.__dshChromeFocused = el;
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          const readback = el.textContent ?? '';
          return { tag: el.tagName.toLowerCase(), mode: 'contenteditable', value: readback, verified: readback === text };
        }
        if (el.readOnly || el.disabled) {
          return {
            error: 'not-editable',
            tag: el.tagName.toLowerCase(),
            state: el.disabled ? 'disabled' : 'readonly',
            combobox: (el.getAttribute('role') || '') === 'combobox' || Boolean(el.getAttribute('aria-haspopup')),
          };
        }
        el.focus();
        globalThis.__dshChromeFocused = el;
        // React (and Vue's v-model) track a control's value through the
        // prototype's setter and compare against their own last-known value.
        // Assigning el.value directly writes an own property that bypasses that
        // setter, so the framework never learns the value changed and reverts
        // the field on its next render: it looks filled, then empties again.
        // Going through the prototype setter is what makes the change visible.
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Read back what the page kept: a framework that rejected or reformatted
        // the value shows up here as verified:false instead of a silent no-op.
        const readback = el.value ?? '';
        return { tag: el.tagName.toLowerCase(), mode: 'value', value: readback, verified: readback === text };`,
    )
    if (result.error === 'not-editable') {
      throw new Error(
        `${selector} is ${result.state}${result.combobox ? '; it looks like a dropdown control — use select instead' : ''}`,
      )
    }
    return { success: true, ...result }
  },
  async upload({ session, selector, paths }) {
    const tabId = currentTab(session)
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('upload requires at least one file path')
    const target = await runOnElement(tabId, selector, `
      const isFile = node => node instanceof HTMLInputElement && node.type === 'file';
      let input = isFile(el) ? el : null;
      let resolvedBy = input ? 'direct' : '';
      if (!input && el instanceof HTMLLabelElement && el.htmlFor) {
        const node = document.getElementById(el.htmlFor);
        if (isFile(node)) { input = node; resolvedBy = 'label-for'; }
      }
      if (!input) {
        const label = el.closest('label');
        const node = label && label.querySelector('input[type=file]');
        if (isFile(node)) { input = node; resolvedBy = 'label-wrap'; }
      }
      if (!input) {
        for (const attr of ['aria-controls', 'aria-describedby']) {
          const ids = (el.getAttribute(attr) || '').trim().split(/\s+/).filter(Boolean);
          const nodes = ids.flatMap(id => {
            const owner = document.getElementById(id);
            if (!owner) return [];
            return isFile(owner) ? [owner] : Array.from(owner.querySelectorAll('input[type=file]'));
          });
          if (nodes.length === 1) { input = nodes[0]; resolvedBy = attr; break; }
        }
      }
      if (!input) {
        let owner = el;
        while (owner && owner !== document.body) {
          const nodes = Array.from(owner.querySelectorAll('input[type=file]'));
          if (nodes.length === 1) { input = nodes[0]; resolvedBy = 'container'; break; }
          if (nodes.length > 1) return { error: 'ambiguous', count: nodes.length };
          owner = owner.parentElement;
        }
      }
      if (!input) return { error: 'not-found' };
      if (input.disabled) return { error: 'disabled' };
      globalThis.__dshChromeUploadInput = input;
      return { multiple: input.multiple, resolvedBy };
    `)
    if (target.error === 'ambiguous') throw new Error(selector + ' matches a container with ' + target.count + ' file inputs; pass a more specific selector')
    if (target.error === 'not-found') throw new Error(selector + ' is not a file input and has no uniquely associated <input type="file">')
    if (target.error === 'disabled') throw new Error('the file input associated with ' + selector + ' is disabled')
    if (paths.length > 1 && !target.multiple) throw new Error('the file input associated with ' + selector + ' does not allow multiple files')
    const { result } = await cdp(tabId, 'Runtime.evaluate', { expression: 'globalThis.__dshChromeUploadInput' })
    const objectId = result?.objectId
    if (!objectId) throw new Error('cannot resolve the file input associated with ' + selector)
    try {
      await cdp(tabId, 'DOM.setFileInputFiles', { objectId, files: paths })
    } finally {
      await cdp(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {})
      await evaluateInPage(tabId, 'delete globalThis.__dshChromeUploadInput').catch(() => {})
    }
    return { success: true, count: paths.length, resolvedBy: target.resolvedBy }
  },

  async evaluate({ session, code }) {
    const tabId = currentTab(session)
    // Callers write either a single expression ("document.title") or a body of
    // several statements. The expression form must be wrapped so its value is
    // returned; a statement body must not be, or it fails to compile. Choosing
    // by syntax is unreliable, so compile the expression form first and fall
    // back to the body form when Chrome rejects it.
    const asExpression = `(async () => (${code}))()`
    const asBody = `(async () => { ${code} })()`
    let value
    try {
      value = await evaluateInPage(tabId, asExpression)
    } catch (expressionFailure) {
      // The body form is the strictly more general shape, so retry with it
      // whenever the expression form fails to produce a value, and surface the
      // body form's own error if that fails too.
      try {
        value = await evaluateInPage(tabId, asBody)
      } catch (bodyFailure) {
        throw /SyntaxError/.test(String(bodyFailure?.message ?? ''))
          ? expressionFailure
          : bodyFailure
      }
    }
    return { type: typeof value, value }
  },

  async screenshot({ session, format, quality, selector }) {
    const tabId = currentTab(session)
    const params = { format: format === 'jpeg' ? 'jpeg' : 'png', captureBeyondViewport: false }
    if (params.format === 'jpeg') params.quality = clampQuality(quality)
    if (selector) {
      const box = await elementBox(tabId, selector)
      params.clip = { ...box, scale: 1 }
    }
    const { data } = await cdp(tabId, 'Page.captureScreenshot', params)
    // The daemon turns these two keys into a real MCP image block.
    return {
      __image_base64: data,
      __image_mime_type: params.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    }
  },

  async save_as_pdf({ session, paper_format: paper, landscape, scale, print_background: background }) {
    const tabId = currentTab(session)
    const sizes = {
      letter: [8.5, 11],
      a4: [8.27, 11.69],
      legal: [8.5, 14],
      a3: [11.69, 16.54],
      tabloid: [11, 17],
    }
    const [paperWidth, paperHeight] = sizes[paper || 'letter'] || sizes.letter
    const { data } = await cdp(tabId, 'Page.printToPDF', {
      paperWidth,
      paperHeight,
      landscape: Boolean(landscape),
      scale: typeof scale === 'number' ? Math.min(Math.max(scale, 0.1), 2) : 1,
      printBackground: background !== false,
      transferMode: 'ReturnAsBase64',
    })
    return { __file_base64: data, __file_mime_type: 'application/pdf' }
  },

async focus({ session, selector }) {
    const tabId = currentTab(session)
    const result = await runOnElement(
      tabId,
      selector,
      `el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        globalThis.__dshChromeFocused = el;
        return { tag: el.tagName.toLowerCase(), focused: document.activeElement === el };`,
    )
    return { success: true, ...result }
  },

  async select({ session, selector, value }) {
    const tabId = currentTab(session)
    // What kind of control is this? A native <select> is driven through its
    // options list below; anything announcing the ARIA combobox contract
    // (role="combobox" or aria-haspopup) is driven the way a user drives it,
    // through its popup. The signal is the web standard alone — no component
    // library is special-cased, which is what makes this general.
    const inspected = await runOnElement(
      tabId,
      selector,
      `return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        haspopup: el.getAttribute('aria-haspopup') || '',
      };`,
    )
    if (inspected.tag !== 'select') {
      if (inspected.role === 'combobox' || inspected.haspopup) {
        return selectFromAriaDropdown(tabId, selector, String(value ?? ''))
      }
      throw new Error(
        `${selector} is a <${inspected.tag}>, not a <select> or an ARIA combobox; use fill or click instead`,
      )
    }
    const target = elementExpression(selector)
    // Matching is layered because a caller may know either the option's value
    // attribute or only the text they can see. Exact matches are tried before
    // substring so a query like "Red" cannot pick "Dark Red" while an exact
    // "Red" option exists.
    const result = await evaluateInPage(
      tabId,
      `(() => {
        const el = ${target};
        if (!el) return null;
        const wanted = ${JSON.stringify(String(value ?? ''))};
        const norm = (text) => String(text ?? '').trim();
        const lower = norm(wanted).toLowerCase();
        const options = Array.from(el.options);
        const found =
          options.find((option) => option.value === wanted) ||
          options.find((option) => norm(option.text) === norm(wanted)) ||
          options.find((option) => norm(option.text).toLowerCase() === lower) ||
          options.find((option) => norm(option.text).toLowerCase().includes(lower));
        if (!found) {
          return { error: 'no-option', available: options.map((option) => norm(option.text)).slice(0, 30) };
        }
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        globalThis.__dshChromeFocused = el;
        el.selectedIndex = found.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: found.value, text: norm(found.text), index: found.index };
      })()`,
    )
    if (!result) throw new Error(await missingElementMessage(tabId, selector))
    if (result.error === 'no-option') {
      throw new Error(
        `no option matching "${value}"; available: ${result.available.join(' | ') || '(none)'}`,
      )
    }
    return { success: true, ...result }
  },

  async scroll_into_view({ session, selector }) {
    const tabId = currentTab(session)
    const result = await runOnElement(
      tabId,
      selector,
      `el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return {
          x: r.x, y: r.y, width: r.width, height: r.height,
          centerX: r.x + r.width / 2, centerY: r.y + r.height / 2,
          inViewport: r.top >= 0 && r.left >= 0 &&
            r.bottom <= (globalThis.innerHeight || 0) && r.right <= (globalThis.innerWidth || 0),
        };`,
    )
    return { success: true, ...result }
  },

  async scroll({ session, selector, direction, pixels, deltaX, deltaY }) {
    const tabId = currentTab(session)
    // An explicit delta wins; otherwise a direction plus distance is turned
    // into one, so both the wheel-style and the human-style call agree.
    let dx = typeof deltaX === 'number' ? deltaX : 0
    let dy = typeof deltaY === 'number' ? deltaY : 0
    if (typeof deltaX !== 'number' && typeof deltaY !== 'number') {
      const step = typeof pixels === 'number' ? Math.abs(pixels) : null
      switch (direction) {
        case 'up': dy = -(step ?? -1); break
        case 'left': dx = -(step ?? -1); break
        case 'right': dx = step ?? -1; break
        default: dy = step ?? -1; break
      }
    }
    const target = selector ? elementExpression(selector) : 'null'
    const result = await evaluateInPage(
      tabId,
      `(() => {
        const el = ${target};
        ${selector ? `if (!el) return null;` : ''}
        const view = globalThis.innerHeight || 0;
        const fallback = Math.max(Math.round(view * 0.8), 1);
        let dx = ${dx};
        let dy = ${dy};
        if (dx === -1) dx = Math.max(Math.round((globalThis.innerWidth || 0) * 0.8), 1);
        if (dy === -1) dy = fallback;
        if (dx === 1) dx = -Math.max(Math.round((globalThis.innerWidth || 0) * 0.8), 1);
        if (dy === 1) dy = -fallback;
        const box = el || document.scrollingElement || document.documentElement;
        const before = { top: box.scrollTop, left: box.scrollLeft };
        if (el) el.scrollBy(dx, dy); else globalThis.scrollBy(dx, dy);
        const after = { top: box.scrollTop, left: box.scrollLeft };
        return {
          scrolledBy: { x: dx, y: dy },
          from: before,
          to: after,
          moved: before.top !== after.top || before.left !== after.left,
          atEnd: Math.ceil(after.top + box.clientHeight) >= box.scrollHeight,
        };
      })()`,
    )
    if (!result) throw new Error(await missingElementMessage(tabId, selector))
    return { success: true, ...result }
  },

  async find({ session, query }) {
    const tabId = currentTab(session)
    // Refs are appended to the table the last snapshot built, never replacing
    // it, so a find in the middle of a task cannot invalidate refs the model is
    // still holding from its snapshot.
    const result = await evaluateInPage(
      tabId,
      `(() => {
        const wanted = ${JSON.stringify(String(query ?? '').trim().toLowerCase())};
        if (!wanted) return { matches: [] };
        const nodes = Array.from(document.querySelectorAll(
          'a, button, input, select, textarea, summary, [role], [onclick], [contenteditable], [tabindex]'
        ));
        const visible = (el) => {
          if (!el.getClientRects().length) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none';
        };
        const label = (el) => [
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('title'),
          el.getAttribute('name'),
          el.getAttribute('value'),
          el.id,
          el.innerText || el.textContent,
        ].map((text) => String(text ?? '').trim()).filter(Boolean);
        // A query like "sign in button" names the target and its kind, so the
        // element's own role counts as searchable text too. Otherwise the
        // extra noun would stop an otherwise exact label from matching. The
        // words a user reaches for rarely match the HTML tag name, so each
        // kind also answers to its common synonyms.
        const kindWords = {
          select: ['dropdown', 'combobox', 'picker', 'menu', 'list'],
          input: ['field', 'box', 'textbox'],
          textarea: ['field', 'box', 'textbox'],
          a: ['link'],
          button: ['btn'],
        };
        // Double backslash: this lives in a template literal, so \\s is what
        // reaches the page as \s. A single \s would collapse to a literal "s".
        const words = wanted.split(/\\s+/).filter(Boolean);
        const score = (texts, role) => {
          const kinds = role ? [role].concat(kindWords[role] || []) : [];
          const haystack = texts.concat(kinds).map((t) => t.toLowerCase());
          let best = 0;
          for (const text of haystack) {
            if (text === wanted) best = Math.max(best, 100);
            else if (text.startsWith(wanted)) best = Math.max(best, 80);
            else if (text.includes(wanted)) best = Math.max(best, 60);
          }
          if (best) return best;
          // Fall back to per-word coverage across every attribute at once, so
          // "sign in button" matches a <button> labelled "Sign in".
          if (words.length > 1) {
            const covered = words.filter((word) => haystack.some((text) => text.includes(word)));
            if (covered.length === words.length) return 50;
            if (covered.length > 1) return 30 + covered.length;
          }
          return 0;
        };
        const scored = [];
        for (const el of nodes) {
          if (!visible(el)) continue;
          const texts = label(el);
          const points = score(texts, el.getAttribute('role') || el.tagName.toLowerCase());
          if (!points) continue;
          scored.push({ el, points, text: (texts[texts.length - 1] || texts[0] || '').slice(0, 120) });
        }
        scored.sort((a, b) => b.points - a.points);
        const top = scored.slice(0, 5);
        // The table snapshot publishes is keyed by backend node id, which this
        // page context cannot read. Allocating above the highest key in use
        // keeps a found ref from ever standing on a snapshot's ref.
        globalThis.__dshChromeRefs = globalThis.__dshChromeRefs || {};
        const table = globalThis.__dshChromeRefs;
        let nextKey = 1;
        for (const key of Object.keys(table)) {
          const numeric = Number(key);
          if (Number.isFinite(numeric) && numeric >= nextKey) nextKey = numeric + 1;
        }
        const matches = top.map((hit) => {
          const index = nextKey++;
          table[index] = hit.el;
          const el = hit.el;
          const hint = el.id
            ? '#' + el.id
            : el.getAttribute('name')
              ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]'
              : el.tagName.toLowerCase();
          return {
            ref: '@e' + index,
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            text: hit.text,
            score: hit.points,
            selectorHint: hint,
          };
        });
        return { matches };
      })()`,
    )
    const matches = result?.matches ?? []
    if (!matches.length) throw new Error(`nothing on the page matches "${query}"`)
    return { success: true, matches, best: matches[0].ref }
  },

  async get_text({ session, raw, maxChars }) {
    const tabId = currentTab(session)
    const cap = typeof maxChars === 'number' && maxChars > 0 ? Math.round(maxChars) : 20000
    // The readable mode works on a clone: stripping nodes from the live
    // document would visibly break the page the user is looking at.
    const text = await evaluateInPage(
      tabId,
      `(() => {
        if (${Boolean(raw)}) return document.body ? document.body.innerText : '';
        const root = document.body ? document.body.cloneNode(true) : null;
        if (!root) return '';
        const noise = root.querySelectorAll(
          'nav, header, footer, aside, script, style, noscript, iframe, svg, form[role="search"],' +
          ' [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"],' +
          ' [class*="advert"], [class*="banner"], [class*="cookie"], [class*="sidebar"],' +
          ' [class*="promo"], [id*="advert"], [id*="cookie"]'
        );
        for (const node of noise) node.remove();
        const main = root.querySelector('main, article, [role="main"]') || root;
        return main.innerText || '';
      })()`,
    )
    const collapsed = String(text ?? '').replace(/\n{3,}/g, '\n\n').trim()
    const truncated = collapsed.length > cap
    return {
      success: true,
      mode: raw ? 'raw' : 'readable',
      chars: Math.min(collapsed.length, cap),
      truncated,
      text: truncated ? collapsed.slice(0, cap) : collapsed,
    }
  },

  async mouse_click({ session, x, y, selector, button, clickCount }) {
    const tabId = currentTab(session)
    let point = { x, y }
    if (!selector && (point.x === undefined || point.y === undefined)) {
      throw new Error('pass selector, or both x and y')
    }
    point = await trustedClick(tabId, point.x, point.y, {
      selector,
      button: button || 'left',
      clickCount: Math.min(Math.max(clickCount || 1, 1), 3),
    })
    return { success: true, x: point.x, y: point.y, trusted: true }
  },

  async key_type({ session, text }) {
    const tabId = currentTab(session)
    await focusTab(tabId)
    await cdp(tabId, 'Input.insertText', { text: String(text ?? '') })
    return { success: true, length: String(text ?? '').length, trusted: true }
  },

  async send_keys({ session, keys }) {
    const tabId = currentTab(session)
    await focusTab(tabId)
    const parts = String(keys || '').split('+')
    const keyName = parts.pop()
    const modifiers = parts.reduce((mask, name) => mask | modifierBit(name), 0)
    const descriptor = keyDescriptor(keyName)
    if (!descriptor) throw new Error(`unsupported key: ${keys}`)
    // A printable character arrives as 'keyDown' carrying 'text' so the page
    // inserts it. A control key (Enter, Tab, Escape) must arrive as
    // 'rawKeyDown': Chrome only performs the key's default action — submitting
    // a form, dismissing a dialog — for a raw event, and a 'keyDown' with text
    // would insert a newline instead of submitting.
    const { printable, ...event } = descriptor
    const type = printable && !modifiers ? 'keyDown' : 'rawKeyDown'
    await cdp(tabId, 'Input.dispatchKeyEvent', { type, modifiers, ...event })
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...event })
    return { success: true, keys, trusted: true }
  },

  async hover({ session, selector, x, y }) {
    const tabId = currentTab(session)
    let point = { x, y }
    if (selector) {
      const box = await elementBox(tabId, selector)
      point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    if (typeof point.x !== 'number' || typeof point.y !== 'number') {
      throw new Error('pass selector, or both x and y')
    }
    // Hover is trusted input, so like mouse_click it only lands on a focused
    // tab; a background tab would accept the command and drop the event.
    await focusTab(tabId, { restoreFocus: false })
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
    })
    return { success: true, x: point.x, y: point.y, trusted: true }
  },

  async wait({ session, ms }) {
    // Deliberately does not touch the tab: a caller may want to pause before
    // the session has navigated anywhere.
    const requested = typeof ms === 'number' ? ms : 0
    const waited = Math.min(Math.max(Math.round(requested), 0), 3000)
    await new Promise((resolve) => setTimeout(resolve, waited))
    return { success: true, waited, clamped: waited !== Math.round(requested) }
  },

  async wait_for_selector({ session, selector, state, timeout }) {
    const tabId = currentTab(session)
    const wantHidden = state === 'hidden'
    const budget = typeof timeout === 'number' ? Math.min(Math.max(timeout, 0), 30000) : 5000
    const target = elementExpression(selector)
    const startedAt = Date.now()
    const probe = `(() => {
      const el = ${target};
      if (!el) return false;
      if (!el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    })()`
    for (;;) {
      let visible = false
      try {
        visible = Boolean(await evaluateInPage(tabId, probe))
      } catch {
        // A navigation mid-poll tears down the context; treat it as not-yet
        // and let the next tick re-evaluate against the new document.
        visible = false
      }
      if (visible !== wantHidden) {
        return { success: true, selector, state: wantHidden ? 'hidden' : 'visible', waited: Date.now() - startedAt }
      }
      if (Date.now() - startedAt >= budget) {
        throw new Error(
          `${selector} was still ${wantHidden ? 'visible' : 'not visible'} after ${Date.now() - startedAt}ms`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  },

  async network({ session, filter, method, status, limit }) {
    const tabId = currentTab(session)
    // Touch the tab so the Network domain is enabled even if this is the first
    // tool used on it; entries only exist from attach time onward.
    await attach(tabId)
    const log = networkLog.get(tabId) || { entries: [], dropped: 0 }
    const wantedMethod = method ? String(method).toUpperCase() : null
    const needle = filter ? String(filter) : null
    const requests = log.entries
      .filter((entry) => (wantedMethod ? entry.method === wantedMethod : true))
      .filter((entry) => (typeof status === 'number' ? entry.status === status : true))
      .filter((entry) => (needle ? entry.url.includes(needle) : true))
      .slice(-(typeof limit === 'number' ? Math.min(Math.max(limit, 1), 200) : 50))
      .map((entry) => ({
        requestId: entry.requestId,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        resourceType: entry.resourceType,
        ...(entry.failed ? { failed: entry.failed } : {}),
      }))
    return { success: true, requests, total: log.entries.length, dropped: log.dropped }
  },

  async network_detail({ session, requestId, body }) {
    const tabId = currentTab(session)
    const log = networkLog.get(tabId)
    const entry = log?.entries.find((candidate) => candidate.requestId === requestId)
    if (!entry) throw new Error(`no request ${requestId} recorded for this tab; call network first`)
    const detail = {
      requestId: entry.requestId,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      statusText: entry.statusText || '',
      mimeType: entry.mimeType || '',
      resourceType: entry.resourceType,
      requestHeaders: entry.requestHeaders || {},
      responseHeaders: entry.responseHeaders || {},
      ...(entry.failed ? { failed: entry.failed } : {}),
    }
    if (!body) return { success: true, ...detail }
    try {
      const response = await cdp(tabId, 'Network.getResponseBody', { requestId })
      // sendCommand resolves with a CDP error object as often as it rejects, so
      // both shapes have to be treated as "the body is gone".
      if (response?.error || response?.code) {
        detail.bodyError = cdpErrorMessage(response, 'body unavailable')
      } else if (typeof response?.body !== 'string') {
        detail.bodyError = 'body unavailable'
      } else {
        const raw = response.base64Encoded ? atob(response.body) : response.body
        const cap = 50000
        detail.body = raw.length > cap ? raw.slice(0, cap) : raw
        detail.bodyTruncated = raw.length > cap
      }
    } catch (failure) {
      detail.bodyError = cdpErrorMessage(failure, 'body unavailable')
    }
    // Chrome discards bodies for redirects, cached entries, and once the page
    // navigates away, so a missing body is an expected outcome that must not
    // fail the call: the headers the caller also asked for are still useful.
    if (detail.bodyError) {
      detail.bodyHint = 'Chrome keeps response bodies only while the page is still loaded; re-request the page and read the body before navigating.'
    }
    return { success: true, ...detail }
  },

  async dialog({ session, action, text }) {
    const tabId = currentTab(session)
    const pending = pendingDialogs.get(tabId)
    if (!pending) {
      throw new Error('no dialog is open on this tab; call dialog only after one appears')
    }
    const accept = action !== 'dismiss'
    const params = { accept }
    if (accept && typeof text === 'string') params.promptText = text
    await cdp(tabId, 'Page.handleJavaScriptDialog', params)
    pendingDialogs.delete(tabId)
    return {
      success: true,
      action: accept ? 'accept' : 'dismiss',
      dialogType: pending.type,
      message: pending.message,
    }
  },
}

// ---------------------------------------------------------------- tool helpers

function isSessionTab(session, tabId) {
  return sessionTabs.get(session) === tabId
}

function clampQuality(quality) {
  if (typeof quality !== 'number') return 80
  return Math.min(Math.max(Math.round(quality), 0), 100)
}

/** Wait until a tab finishes loading, bounded so a hung page cannot wedge us. */
function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done()
    }
    const timer = setTimeout(done, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') done()
    })
  })
}

/** Viewport box of an element, for a clipped screenshot. */
async function elementBox(tabId, selector) {
  // Scrolled into view first: viewport coordinates of an off-screen element
  // are real numbers that point at nothing.
  return runOnElement(
    tabId,
    selector,
    `el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };`,
  )
}

/**
 * Resolve a selector to the CDP backend node id of its element.
 *
 * Evaluates without returnByValue so the answer is a protocol handle, then
 * asks the DOM domain to describe it. Retries once, like every element
 * resolution, because a framework re-render replaces nodes mid-call.
 */
async function backendNodeId(tabId, selector) {
  const expression = `(() => { const el = ${elementExpression(selector)}; return el || null; })()`
  let response = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: false })
  if (!response?.result?.objectId) {
    await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_MS))
    response = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: false })
  }
  const objectId = response?.result?.objectId
  if (response?.exceptionDetails || !objectId) {
    throw new Error(await missingElementMessage(tabId, selector))
  }
  try {
    const { node } = await cdp(tabId, 'DOM.describeNode', { objectId })
    if (!node?.backendNodeId) throw new Error(`cannot resolve ${selector} to a DOM node`)
    return node.backendNodeId
  } finally {
    await cdp(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

/** How long a custom dropdown gets to show its options after the opening click. */
const DROPDOWN_OPEN_TIMEOUT_MS = 2000
/** Poll interval while waiting for those options. */
const DROPDOWN_POLL_MS = 100
/** How long an open popup gets to render clickable options before the keyboard takes over. */
const DROPDOWN_KEYBOARD_AFTER_MS = 500
/** Most ArrowDown steps a keyboard walk takes before concluding it is lost. */
const DROPDOWN_WALK_LIMIT = 120

/**
 * Drive a custom dropdown through the ARIA combobox contract.
 *
 * Every signal here is a web standard and none is a component library: the
 * control was recognised by role/aria-haspopup, its popup is whatever visible
 * [role="option"] items appear after a trusted click (scoped to the element
 * aria-controls/aria-owns names when present; popups commonly portal to
 * <body>, so the fallback scope is the whole document), and the choice is a
 * trusted click on the matched option. Libraries that follow the pattern all
 * work for the same reason; one that ignores ARIA gets a clear error naming
 * the fallback.
 */
async function selectFromAriaDropdown(tabId, selector, wanted) {
  const initial = await evaluateInPage(tabId, `(() => {
    const target = ${elementExpression(selector)};
    if (!target || !target.isConnected) return null;
    const owner = target.getAttribute('aria-expanded') != null ? target : (target.closest('[aria-expanded]') || target);
    return { opened: owner.getAttribute('aria-expanded') === 'true' || Boolean(target.getAttribute('aria-activedescendant')) };
  })()`)
  if (!initial?.opened) await trustedClick(tabId, undefined, undefined, { selector })

  const probe = `(() => {
    const target = ${elementExpression(selector)};
    const scopeId = target && (target.getAttribute('aria-controls') || target.getAttribute('aria-owns'));
    const scope = scopeId ? document.getElementById(scopeId) : null;
    const pool = (scope || document).querySelectorAll('[role="option"]');
    const options = [];
    for (const option of pool) {
      const r = option.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(option);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const refs = globalThis.__dshChromeOptionRefs || (globalThis.__dshChromeOptionRefs = Object.create(null));
      const ref = 'o' + Math.random().toString(36).slice(2);
      refs[ref] = option;
      options.push({
        ref,
        text: (option.innerText || option.textContent || '').trim().slice(0, 120),
      });
    }
    const owner = target && target.getAttribute('aria-expanded') != null
      ? target
      : (target ? (target.closest('[aria-expanded]') || target) : null);
    return {
      options,
      // Open means the combobox says so: aria-expanded, or an active option
      // being named. Deliberately NOT the mere presence of [role="option"]
      // nodes — several libraries leave the closed popup's zero-sized
      // screen-reader list in the DOM, and counting it misreads a closed
      // popup as open.
      opened: Boolean(
        (owner && owner.getAttribute('aria-expanded') === 'true') ||
        (target && target.getAttribute('aria-activedescendant')),
      ),
    };
  })()`

  let options = []
  let opened = false
  const startedAt = Date.now()
  for (;;) {
    const state = await evaluateInPage(tabId, probe)
    options = state?.options ?? []
    opened = Boolean(state?.opened)
    if (options.length || Date.now() - startedAt >= DROPDOWN_OPEN_TIMEOUT_MS) break
    // An open popup with no clickable [role="option"] is the
    // aria-activedescendant variant of the pattern; give the visible kind a
    // few polls to render, then switch to the keyboard.
    if (opened && Date.now() - startedAt >= DROPDOWN_KEYBOARD_AFTER_MS) break
    await new Promise((resolve) => setTimeout(resolve, DROPDOWN_POLL_MS))
  }
  if (!options.length && opened) {
    // The other half of the ARIA combobox pattern: options are named by
    // aria-activedescendant and chosen with the keyboard, and the visible
    // list is presentation-only. Standard, and library-agnostic.
    const chosen = await selectByActiveDescendant(tabId, selector, wanted)
    if (chosen) return chosen
    // The popup opened but named no options; close it so the failure below
    // leaves the page the way this call found it.
    try {
      await trustedKey(tabId, 'Escape')
    } catch {
      // Cleanup only.
    }
  }
  if (!options.length) {
    throw new Error(
      `clicking ${selector} showed no [role="option"] items within ${DROPDOWN_OPEN_TIMEOUT_MS}ms; this control does not follow the ARIA combobox pattern — drive it with click (trusted: true) instead`,
    )
  }

  const norm = (text) => String(text ?? '').trim()
  const lower = norm(wanted).toLowerCase()
  const found =
    options.find((option) => norm(option.text) === norm(wanted)) ||
    options.find((option) => norm(option.text).toLowerCase() === lower) ||
    options.find((option) => norm(option.text).toLowerCase().includes(lower))
  if (!found) {
    // Close the popup this call opened, so the caller retries from a clean
    // page. Best effort: a popup that ignores Escape is untidy, not fatal.
    try {
      await trustedKey(tabId, 'Escape')
    } catch {
      // Nothing to clean up with; the error below still tells the story.
    }
    throw new Error(
      `no option matching "${wanted}"; visible options: ${options.map((option) => option.text).slice(0, 30).join(' | ') || '(none)'}`,
    )
  }

  const optionSelector = `@option:${found.ref}`
  await trustedClick(tabId, undefined, undefined, { selector: optionSelector })
  return finishAriaSelection(tabId, selector, norm(found.text))
}

/** Press one non-printable key as trusted input, for driving an open popup. */
async function trustedKey(tabId, name) {
  const { printable, ...event } = keyDescriptor(name)
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 0, ...event })
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, ...event })
}

/**
 * Read the post-choice state back and shape select's custom-mode answer.
 *
 * The popup closing (aria-expanded no longer "true") plus the control's own
 * text is the generic evidence the choice was taken — the same standard the
 * popup was driven through.
 */
async function finishAriaSelection(tabId, selector, text) {
  await new Promise((resolve) => setTimeout(resolve, DROPDOWN_POLL_MS))
  const after = await evaluateInPage(
    tabId,
    `(() => {
      const target = ${elementExpression(selector)};
      if (!target) return null;
      const owner = target.getAttribute('aria-expanded') != null
        ? target
        : (target.closest('[aria-expanded]') || target);
      const display = target.value || (target.parentElement ? target.parentElement.textContent : '') || '';
      return { expanded: owner.getAttribute('aria-expanded'), display: display.trim().slice(0, 120) };
    })()`,
  )

  return {
    success: true,
    mode: 'custom',
    text,
    verified: after ? after.expanded !== 'true' : false,
    display: after ? after.display : '',
  }
}

/**
 * Choose from an aria-activedescendant combobox with the keyboard.
 *
 * The second half of the ARIA combobox pattern: the visible list is
 * presentation-only, and the active option is named by the combobox's
 * aria-activedescendant as ArrowDown walks it. Still nothing but the
 * standard: walk, read the named option's text, press Enter on the match.
 *
 * Returns null when the control never names an active option, so the caller
 * reports the pattern failure once, with the click-path error.
 */
async function selectByActiveDescendant(tabId, selector, wanted) {
  const read = `(() => {
    const target = ${elementExpression(selector)};
    if (!target) return null;
    const activeId = target.getAttribute('aria-activedescendant') || '';
    const active = activeId ? document.getElementById(activeId) : null;
    return { activeId, text: active ? (active.textContent || '').trim().slice(0, 120) : '' };
  })()`
  const norm = (text) => String(text ?? '').trim()
  const lower = norm(wanted).toLowerCase()
  const step = async () => {
    await trustedKey(tabId, 'ArrowDown')
    await new Promise((resolve) => setTimeout(resolve, 50))
    return evaluateInPage(tabId, read)
  }
  const commit = async (text) => {
    await trustedKey(tabId, 'Enter')
    return finishAriaSelection(tabId, selector, text)
  }

  let state = await evaluateInPage(tabId, read)
  // Some popups only name an active option once the keyboard engages.
  if (!state?.activeId) state = await step()
  if (!state?.activeId) return null

  // First lap collects the cycle, committing immediately on an exact match:
  // nothing later in the walk can outrank one.
  const seen = new Map()
  while (state?.activeId && !seen.has(state.activeId) && seen.size < DROPDOWN_WALK_LIMIT) {
    const text = norm(state.text)
    seen.set(state.activeId, text)
    if (text === norm(wanted) || text.toLowerCase() === lower) return commit(text)
    state = await step()
  }

  // The cycle is known; settle for a substring match and walk back to it.
  const entries = [...seen.entries()]
  const target = entries.find(([, text]) => text.toLowerCase().includes(lower))
  if (!target) {
    try {
      await trustedKey(tabId, 'Escape')
    } catch {
      // Leaving the popup open is untidy, not fatal.
    }
    throw new Error(
      `no option matching "${wanted}"; options: ${entries.map(([, text]) => text).slice(0, 30).join(' | ') || '(none)'}`,
    )
  }
  for (let hops = 0; hops <= entries.length + 1; hops += 1) {
    if (state?.activeId === target[0]) return commit(target[1])
    state = await step()
  }
  try {
    await trustedKey(tabId, 'Escape')
  } catch {
    // Same: cleanup only.
  }
  throw new Error(
    `the popup's active option never returned to "${target[1]}"; drive it with click (trusted: true) instead`,
  )
}

// ---------------------------------------------------------------- snapshot

/**
 * Read the tab's accessibility tree, re-arming the domain if it answers empty.
 *
 * Chrome builds the accessibility tree lazily and drops it again when nothing
 * is listening. On a heavy single-page app the tree can therefore come back as
 * a bare `RootWebArea` with no children even though the DOM is fully rendered —
 * `Accessibility.enable` was sent at attach, long before this page existed.
 * Re-enabling forces Chrome to rebuild it, so a one-node answer is retried
 * rather than reported as an empty page.
 *
 * `pierce: true` walks into shadow roots, so a control inside a web component
 * is described rather than reported as an opaque host element.
 */
async function fetchAxNodes(tabId) {
  const first = await cdp(tabId, 'Accessibility.getFullAXTree', { pierce: true })
  if ((first?.nodes?.length ?? 0) > 1) return first.nodes

  await cdp(tabId, 'Accessibility.enable')
  const second = await cdp(tabId, 'Accessibility.getFullAXTree', { pierce: true })
  // Whichever answer is richer: the retry normally wins, but a genuinely empty
  // page must not be turned into an error.
  return (second?.nodes?.length ?? 0) >= (first?.nodes?.length ?? 0)
    ? (second?.nodes ?? [])
    : first.nodes
}

/** Output modes `snapshot` accepts. */
const SNAPSHOT_MODES = new Set(['interactive', 'full', 'text'])

/**
 * Token ceiling a snapshot renders within unless the caller says otherwise.
 *
 * Chosen to hold a typical page's controls whole while keeping a pathological
 * one — an endless feed, a table of thousands of cells — from swallowing the
 * context window. A caller who needs more can raise it per call.
 */
const DEFAULT_MAX_TOKENS = 2000

/**
 * Roles a user can act on. These are the only nodes that carry a ref, because a
 * ref exists to be handed back to `click`/`fill`.
 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'textarea',
])

/**
 * Non-actionable roles that still carry the structure an agent needs to make
 * sense of the controls around them.
 *
 * Kept deliberately tight. Headings give the page its outline, table cells and
 * captions label the controls inside them, and an image is often the only name
 * a media control has. Excluded on purpose: `StaticText` (it repeats its
 * parent's name), `paragraph`/`listitem` (container noise), and the landmark
 * roles `banner`/`main`/`navigation`/`region` (a level of nesting and no
 * content). Reading prose is `get_text`'s job, not the snapshot's.
 */
const CONTEXT_ROLES = new Set([
  'heading', 'image', 'cell', 'columnheader', 'rowheader', 'caption', 'figure',
])

/** Roles kept by `mode: 'text'`, where prose matters and controls do not. */
const TEXT_ROLES = new Set([...CONTEXT_ROLES, 'StaticText', 'paragraph'])

/**
 * Roles that never say anything on their own. `generic`/`none` are the
 * anonymous wrappers a framework emits by the hundred, and `InlineTextBox` is
 * the per-line split of a text run whose parent already carries the whole text.
 */
const SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox'])

/** Longest `name` kept before it is elided, in characters. */
const NAME_LIMIT = 120

/**
 * Stand-in for a password's content.
 *
 * The width is fixed rather than proportional: a snapshot is text the model
 * reads and may echo, so a mask that tracked the real length would leak it.
 */
const MASKED_VALUE = '\u2022'.repeat(8)

/** `autocomplete` tokens marking a field whose value must never be printed. */
const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password'])

/** Collapse runs of whitespace and drop control characters. */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clampText(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}\u2026` : value
}

/** Read one AX property by name, as a string. */
function axProperty(node, name) {
  for (const property of node.properties || []) {
    if (property.name === name) {
      const value = property.value?.value
      return value == null ? '' : String(value)
    }
  }
  return ''
}

/**
 * Flatten a CDP accessibility tree into the rows the formatter prints.
 *
 * Returns rows of `{ ref, role, name, depth, ... }` rather than a nested tree:
 * once the output is indented text, `depth` alone carries the shape, and a flat
 * list makes budget truncation a matter of keeping a prefix.
 *
 * @param nodes - `Accessibility.getFullAXTree` nodes, verbatim.
 * @param options - `mode` (interactive|full|text) and `maxDepth` (-1 uncapped).
 * @returns the kept rows and the backend node ids their refs point at.
 */
function buildAxTree(nodes, { mode = 'interactive', maxDepth = -1, rootBackendId = null } = {}) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))

  const parentOf = new Map()
  for (const node of nodes) {
    for (const childId of node.childIds || []) parentOf.set(childId, node.nodeId)
  }

  // Chrome reports `hidden` only on the node carrying the style, so the flag
  // has to be inherited: the children of an `aria-hidden` container are just as
  // invisible as the container itself.
  const hiddenSelf = new Set(
    nodes.filter((node) => axProperty(node, 'hidden') === 'true').map((node) => node.nodeId),
  )
  const hiddenCache = new Map()
  const isHidden = (nodeId) => {
    if (hiddenCache.has(nodeId)) return hiddenCache.get(nodeId)
    const chain = []
    let current = nodeId
    let inherited = false
    while (current != null && !hiddenCache.has(current)) {
      chain.push(current)
      if (hiddenSelf.has(current)) {
        inherited = true
        break
      }
      current = parentOf.get(current)
    }
    if (!inherited && current != null) inherited = hiddenCache.get(current) ?? false
    // Every node on the walked chain shares the answer, so one walk settles all
    // of them and the whole pass stays linear.
    for (const id of chain) hiddenCache.set(id, inherited)
    return inherited
  }

  /** Does this role survive the requested mode? */
  const keptByMode = (role) => {
    if (mode === 'full') return true
    if (mode === 'text') return TEXT_ROLES.has(role)
    return INTERACTIVE_ROLES.has(role) || CONTEXT_ROLES.has(role)
  }

  const rows = []
  const backendIds = []
  const visited = new Set()

  /**
   * Walk one node, appending the rows it and its subtree contribute.
   *
   * A skipped node does not take its subtree with it. Chrome marks the generic
   * wrappers (`<html>`, `<body>`, framework `<div>`s) as `ignored`, and on a
   * real page the content sits several of them deep, so a skipped node hands
   * its children to its own parent at its own depth. Dropping the subtree here
   * would drop the page.
   */
  const visit = (nodeId, depth) => {
    if (visited.has(nodeId)) return
    const node = byId.get(nodeId)
    if (!node) return
    visited.add(nodeId)
    if (maxDepth >= 0 && depth > maxDepth) return

    const role = node.role?.value || ''
    const name = normalizeText(node.name?.value)
    const skipped =
      node.ignored ||
      SKIPPED_ROLES.has(role) ||
      (role === 'StaticText' && !name) ||
      isHidden(nodeId) ||
      !keptByMode(role)

    let childDepth = depth
    if (!skipped) {
      const row = {
        role,
        name: mode === 'interactive' ? clampText(name, NAME_LIMIT) : name,
        depth,
      }

      // A ref is a handle for acting on an element, so only nodes that can be
      // acted on — and that the page can still resolve — get one.
      if (mode !== 'text' && INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId != null) {
        row.ref = `@e${node.backendDOMNodeId}`
        row.backendId = node.backendDOMNodeId
        backendIds.push(node.backendDOMNodeId)
      }

      const value = normalizeText(node.value?.value)
      if (value) row.value = clampText(value, NAME_LIMIT)
      // Unconditional, and last: this is the only thing standing between a
      // password manager's autofill and a snapshot the model reads back.
      if (SENSITIVE_AUTOCOMPLETE.has(axProperty(node, 'autocomplete').toLowerCase())) {
        row.value = MASKED_VALUE
      }

      // Verbatim from the tree, including "mixed": a native indeterminate box
      // and `aria-checked="mixed"` both report it, and absent has to keep
      // meaning "this control has no checkedness" rather than "off".
      const checked = axProperty(node, 'checked')
      if (checked === 'true' || checked === 'false' || checked === 'mixed') {
        row.checked = checked
      }
      if (axProperty(node, 'disabled') === 'true') row.disabled = true
      if (axProperty(node, 'focused') === 'true') row.focused = true

      // A node with nothing to say and no way to be acted on is pure indent.
      if (row.name || row.ref || row.value) {
        rows.push(row)
        childDepth = depth + 1
      }
    }

    for (const childId of node.childIds || []) visit(childId, childDepth)
  }

  // A scoped walk starts at the requested element and covers only its
  // subtree; everything outside it simply does not exist for this snapshot.
  if (rootBackendId != null) {
    const rootNode = nodes.find((node) => node.backendDOMNodeId === rootBackendId)
    if (rootNode) visit(rootNode.nodeId, 0)
    return { rows: dedupeSiblings(rows), backendIds }
  }

  // Parentless nodes first, so the natural document order drives the walk.
  for (const node of nodes) {
    if (!parentOf.has(node.nodeId)) visit(node.nodeId, 0)
  }
  // Only if that reached nothing — a tree naming no root at all — fall back to
  // walking every node. This cannot be unconditional: a node still present in
  // the payload but no longer referenced by any parent has been detached from
  // the page, and sweeping it up here would report it as live.
  if (!rows.length) {
    for (const node of nodes) visit(node.nodeId, 0)
  }

  return { rows: dedupeSiblings(rows), backendIds }
}

/**
 * Collapse consecutive rows that say exactly the same thing.
 *
 * Repeated navigation and list rows are the largest single source of redundancy
 * on a real page. Only ref-less rows merge: a row with a ref is a distinct
 * thing the agent can act on, even when it reads identically to its neighbour.
 */
function dedupeSiblings(rows) {
  const out = []
  for (const row of rows) {
    const previous = out[out.length - 1]
    if (
      previous &&
      !previous.ref &&
      !row.ref &&
      previous.depth === row.depth &&
      previous.role === row.role &&
      previous.name === row.name &&
      previous.value === row.value
    ) {
      previous.repeat = (previous.repeat || 1) + 1
      continue
    }
    out.push(row)
  }
  return out
}

/** How a row's checked state is spelled. */
const CHECKED_MARKS = { true: ' [x]', false: ' [ ]', mixed: ' [/]' }

/**
 * Render one row.
 *
 * The single place a row becomes text, which is what lets the budget charge for
 * exactly what the output will contain rather than for a second model of it.
 */
function formatRow(row) {
  let line = '  '.repeat(row.depth)
  if (row.ref) line += `${row.ref} `
  line += row.role
  if (row.name) line += ` "${row.name}"`
  if (row.value) line += ` val="${row.value}"`
  if (row.checked != null && row.checked in CHECKED_MARKS) line += CHECKED_MARKS[row.checked]
  if (row.focused) line += ' *'
  if (row.disabled) line += ' -'
  if (row.repeat) line += ` \u00d7${row.repeat}`
  if (row.marker) line += ` ${row.marker}`
  return line
}

/** Four bytes per token: the one approximation the whole budget rests on. */
function estimateTokens(bytes) {
  return Math.ceil(bytes / 4)
}

/**
 * Render rows as indented text, stopping before the budget is exceeded.
 *
 * The budget is a ceiling and never a target: this keeps the longest prefix
 * that fits, so the only thing it can lose is the first row that did not.
 */
function formatSnapshot(rows) {
  const lines = []
  let bytes = 0
  let kept = 0
  for (const row of rows) {
    const line = formatRow(row)
    bytes += line.length + 1
    if (estimateTokens(bytes) > DEFAULT_MAX_TOKENS) break
    lines.push(line)
    kept += 1
  }
  const dropped = rows.length - kept
  if (dropped > 0) lines.push(`# truncated: ${dropped} more nodes`)
  return { text: lines.join('\n'), kept, truncated: dropped > 0 }
}

/**
 * Return only rows added or changed since `previous`, plus vanished refs.
 *
 * Rows are keyed on role + name + backend id rather than position, so a row
 * keeps its identity when the page shifts it around and a changed value under a
 * stable identity reads as a change rather than as a removal plus an addition.
 * With no baseline, every current row is an addition and is returned with [+].
 */
function diffRows(previous, current) {
  const key = (row) => `${row.role}\u0000${row.name}\u0000${row.backendId ?? ''}`
  const before = new Map((previous || []).map((row) => [key(row), row]))
  const seen = new Set()
  const rows = []

  for (const row of current) {
    const rowKey = key(row)
    seen.add(rowKey)
    const old = before.get(rowKey)
    if (!old) {
      row.marker = '[+]'
      rows.push(row)
    } else if (
      old.value !== row.value ||
      old.checked !== row.checked ||
      old.disabled !== row.disabled ||
      old.focused !== row.focused
    ) {
      row.marker = '[~]'
      rows.push(row)
    }
  }

  const removed = []
  for (const [rowKey, row] of before) {
    if (!seen.has(rowKey) && row.ref) removed.push(row.ref)
  }
  return { rows, removed }
}

/**
 * How many elements `publishRefs` resolves at a time.
 *
 * Each element costs two CDP round trips, so they overlap; the batch keeps the
 * number in flight bounded rather than opening one request per control on a
 * page that has thousands of them.
 */
const REF_BATCH = 32

/**
 * Expose the snapshot's elements to page script as `__dshChromeRefs`, so an
 * `@eN` selector resolves to the very node the snapshot described.
 *
 * The table is keyed by backend node id rather than by position, which is what
 * makes a ref survive an unrelated change elsewhere on the page.
 *
 * It is REPLACED on every snapshot, never merged into. Each entry is a live DOM
 * element, so a table that accumulated across snapshots would pin every element
 * this tab had ever described — and once that graph grows large enough Chrome
 * starts refusing `Runtime.callFunctionOn` outright ("Object reference chain is
 * too long"), which took out repeated snapshots of any large page. Refs from an
 * earlier snapshot are expected to go stale; refs from a `find` that follows
 * this snapshot survive because `find` writes into the table afterwards.
 */
async function publishRefs(tabId, backendIds) {
  await evaluateInPage(tabId, 'globalThis.__dshChromeRefs = {}')

  for (let start = 0; start < backendIds.length; start += REF_BATCH) {
    const batch = backendIds.slice(start, start + REF_BATCH)
    await Promise.all(
      batch.map(async (backendId) => {
        let objectId
        try {
          const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: backendId })
          objectId = object?.objectId
          if (!objectId) return
          await cdp(tabId, 'Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function () { globalThis.__dshChromeRefs[${backendId}] = this }`,
          })
        } catch {
          // A node that vanished between snapshot and resolve is simply unusable.
        } finally {
          // The page-side table now holds the element, so the protocol-level
          // handle has done its job and should not stay retained.
          if (objectId) {
            await cdp(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {})
          }
        }
      }),
    )
  }
}

function modifierBit(name) {
  switch (name.toLowerCase()) {
    case 'alt': return 1
    case 'control': case 'ctrl': return 2
    case 'meta': case 'command': case 'cmd': return 4
    case 'shift': return 8
    default: return 0
  }
}

function keyDescriptor(name) {
  const named = {
    enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  }
  const key = String(name || '').trim()
  const found = named[key.toLowerCase()]
  if (found) return found
  if (key.length === 1) {
    const upper = key.toUpperCase()
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
      printable: true,
    }
  }
  return null
}

// ---------------------------------------------------------------- socket

let socket = null
let state = 'disconnected'
let currentUrl = ''

// 断线期间暂存的可重放帧(工具结果)。连接恢复后按序重放,
// 避免浏览器工具执行期间断线导致 tool_result 被静默丢弃。
const pending = []
const MAX_PENDING = 500

function isConnected() {
  return state === 'connected'
}

function flushPending() {
  if (socket?.readyState !== WebSocket.OPEN || pending.length === 0) return
  while (pending.length) {
    const frame = pending.shift()
    socket.send(JSON.stringify(frame))
  }
}

// replayable: 断线时是否入队等待重放。hello/pong 每次连接重发即可,只有
// 工具结果承载着不可再生的执行产出,值得排队重放。
function send(frame, { replayable = false } = {}) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame))
    return
  }
  if (!replayable) return
  if (pending.length >= MAX_PENDING) {
    // 队列溢出时丢最旧:保留最近的结果比保留最早的有价值。
    pending.shift()
  }
  pending.push(frame)
}

function teardown() {
  if (socket) {
    try {
      socket.close()
    } catch {
      // Already closing.
    }
  }
  socket = null
  state = 'disconnected'
}

async function reconcile() {
  const desired = await getDesired()
  if (!desired.enabled) {
    if (state !== 'disconnected') teardown()
    return
  }
  if (state === 'connected' || state === 'connecting') return
  connect(desired.url)
}

function connect(url) {
  state = 'connecting'
  currentUrl = url
  let candidate
  try {
    candidate = new WebSocket(url)
  } catch {
    state = 'disconnected'
    return
  }
  socket = candidate

  const guard = setTimeout(() => {
    if (socket === candidate && state === 'connecting') candidate.close()
  }, 10000)

  candidate.addEventListener('open', () => {
    if (socket !== candidate) {
      candidate.close()
      return
    }
    state = 'connected'
    clearTimeout(guard)
    send({ type: 'hello', payload: { extensionVersion: chrome.runtime.getManifest().version } })
    flushPending()
  })

  candidate.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    handleFrame(frame)
  })

  const closed = () => {
    if (socket !== candidate) return
    socket = null
    state = 'disconnected'
    clearTimeout(guard)
  }
  candidate.addEventListener('close', closed)
  candidate.addEventListener('error', closed)
}

function handleFrame(frame) {
  switch (frame.type) {
    case 'ping':
      send({ type: 'pong' })
      break
    case 'hello_ack':
      break
    case 'tool_call':
      runToolCall(frame)
      break
    default:
      break
  }
}

async function runToolCall(frame) {
  const { requestId, payload } = frame
  const name = payload?.name
  const handler = name && tools[name]
  if (!handler) {
    send({
      type: 'tool_result',
      responseToRequestId: requestId,
      payload: { error: `unknown tool: ${name}` },
    }, { replayable: true })
    return
  }
  try {
    const data = await handler(payload.args || {})
    send({ type: 'tool_result', responseToRequestId: requestId, payload: { data } }, { replayable: true })
  } catch (failure) {
    send({
      type: 'tool_result',
      responseToRequestId: requestId,
      payload: { error: failure?.message ?? String(failure) },
    }, { replayable: true })
  }
}

// ---------------------------------------------------------------- lifecycle

chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM) reconcile()
})
chrome.runtime.onStartup.addListener(reconcile)
chrome.runtime.onInstalled.addListener(reconcile)

// A changed server address takes effect immediately rather than on the next
// 30s tick: drop the old socket and reconnect against the new URL.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes[STORAGE.backendUrl] || changes[STORAGE.url]) {
    teardown()
    reconcile()
  }
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  ;(async () => {
    switch (message?.type) {
      case 'get_state': {
        const desired = await getDesired()
        respond({
          connected: isConnected(),
          shouldConnect: desired.enabled,
          url: currentUrl || desired.url,
        })
        break
      }
      case 'set_enabled':
        await setEnabled(Boolean(message.enabled))
        respond({ ok: true })
        break
      case 'reconcile':
        // The daemon-supervisor shard asks the bridge to retry its connection
        // immediately after it has started the daemon, rather than wait for
        // the next 30s RECONCILE_ALARM tick.
        await reconcile()
        respond({ ok: true, connected: isConnected() })
        break
      default:
        respond({ ok: false })
    }
  })()
  // Keep the message channel open for the async reply.
  return true
})

reconcile()