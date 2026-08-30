# DSH Chrome Bridge (browser extension)

Two independent halves share one extension:

1. **The bridge.** Lets a DeepSeek Harness agent drive **this** browser — your
   real profile, your real logins — by executing tool calls forwarded from the
   `/chrome/ws` endpoint of your configured `dsh web` server.
2. **The side panel.** A DSH AI chat that talks to that same server (default
   `http://127.0.0.1:3080`). See [The side panel](#the-side-panel).

Neither half needs the other: the bridge works with the panel closed, and the
panel works with agent control switched off.

## Install

Run the one-command installer:

```bash
curl -fsSL https://memorybank-station.qa1fdg.net/codemax-chrome/api/dsh-install.sh | bash
```

It downloads the extension, installs DSH and its plugins, registers the browser
launcher, derives the fixed extension ID from `manifest.json`, and verifies that
the launcher can start `dsh web`. You do not need to copy an extension ID or run
a second script.

Chrome requires one owner-approved action: on the page opened by the installer,
enable **Developer mode**, click **Load unpacked**, and select the folder whose
path was copied to the clipboard. If the extension was already loaded, click
**Reload** on its card.

Chrome may report the extension as "not from the Chrome Web Store". That is
expected for an unpacked extension; leave it enabled.

## Auto-starting the local server (Native Messaging)

The one-command installer registers `com.dsh.chrome` in each installed
Chromium-family browser. When `dsh web` is unavailable, the extension asks this
launcher to start it. The launcher probes the port first, so repeated requests
are safe.

The **Server** settings page shows launcher status and offers **Test start**.
Logs from a launcher-started server go to `~/.dsh-chrome/logs/dsh-web.log`.

For development or targeted repair only, `scripts/install-native-host.sh
<extension-id>` remains available. Normal users should re-run the one-command
installer instead.

## The kill switch

Open the side panel, press **⋮**, and clear **允许 Agent 控制此浏览器** under
*Agent 浏览器控制*. The extension disconnects immediately and stops accepting
tool calls, no matter what the agent does. Use it whenever you want the browser
to yourself.

That section also shows whether the bridge is currently attached to dsh web,
and which derived WebSocket URL it is using. There is no popup: the toolbar icon opens the
panel, because Chrome gives a declared `action.default_popup` precedence over
`openPanelOnActionClick`, so an extension cannot have both.

## What it can do

While connected, the agent can navigate, read pages, click, type, screenshot,
select explicitly named local files for page upload, and print to PDF **using your logged-in sessions**. It can also borrow the tab
you are currently viewing. Two of the tools (`mouse_click`, `key_type`) send
*trusted* input, which pages cannot distinguish from your own typing. Local file upload passes paths directly to Chrome DevTools Protocol. A visible trigger is resolved to its file input through standard label/ARIA relationships or a unique containing input; ambiguous controls are rejected rather than guessed.

Treat granting this the way you would treat handing someone your unlocked
laptop. Turn the toggle off when you are done.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `debugger` | Drives the page over the Chrome DevTools Protocol: the accessibility tree, screenshots, PDF, trusted input. |
| `tabs`, `activeTab`, `windows` | Open, select, read and close the tabs a task uses. |
| `tabGroups` | Collect one task's tabs into a single visible group. |
| `storage` | Remember the DSH server URL and the on/off toggle. |
| `alarms` | Re-check the connection every 30s, because Chrome evicts idle MV3 service workers. |
| `<all_urls>` | The agent may be asked to work on any site; the extension cannot know which in advance. |

## Trusted input brings the tab to the front

`mouse_click`, `key_type`, and `send_keys` generate real browser input, and
Chrome delivers that only to the focused tab of a focused window — input aimed
at a background tab is accepted by the protocol and then silently dropped. Those
three tools therefore **activate their tab before typing**, so you will see the
window come forward. The DOM-level tools (`click`, `fill`, `evaluate`,
`snapshot`, `screenshot`) have no such constraint and work on a hidden tab.

## The side panel

A chat UI for the `dsh web` server running on this machine. Start the server
first (`dsh web`, which listens on `http://127.0.0.1:3080`), then open the panel
any of three ways:

- **click the toolbar icon** (the usual route);
- right-click any page → **打开 DSH AI 侧栏**;
- press **⌘⇧D** (macOS) or **Ctrl+Shift+D**.

A green dot in the panel header means it is connected to `dsh web`. The **⋮**
settings button holds the backend address, the bridge's status and kill switch,
notification and language preferences.

### Switching workspace

The folder dropdown left of the session title scopes the panel to one workspace:
the history list shows only that folder's sessions, and **＋** creates the next
session there. **全部** removes the filter, and **＋ 添加目录…** opens a native
folder picker to register a new workspace. The choice persists across reopens.

A session's directory is fixed when it is created and cannot be changed
afterwards, so switching workspace never moves or interrupts an existing
session — it only decides what you see and where the next one is created. The
label follows whichever session you open; a session whose directory is not a
registered workspace shows its folder name without filtering.

### How it gets past the trust fence

`dsh web` refuses requests whose `Origin` is not its own host, which would
reject every request an extension makes. Two mechanisms work around that, and
both are required:

| Direction | Mechanism |
|---|---|
| Uplink (`POST /api/*`) | A `declarativeNetRequest` rule strips `Origin` and `Sec-Fetch-Site` for the backend's authority. See `src/platform/dsh/fence-rules.js`. |
| Downlink (2 read-only WebSockets) | Chrome will not let DNR rewrite WebSocket handshake headers, so the panel loads a hidden iframe of the backend's own page and `content/dsh-relay.js` opens the sockets from inside that same-origin context, relaying frames by `postMessage`. |

### Layout

```
sw/         service worker shards (one job each), assembled by sw/index.js
src/platform/  DSH protocol: RPC envelopes, downlink, fence rules, settings
src/features/  one directory per domain (chat, sessions, models, …)
src/app/sidepanel/  DOM composition and styles
              (bridge-settings.js is the bridge's status + kill switch)
src/shared/    pure helpers (markdown, i18n, error formatting)
pages/sidepanel/index.html   the panel document
```

`background.js` is the bridge and is imported unmodified by `sw/index.js`;
side-panel logic is never added to it.

## Developing on this extension

After editing `background.js` or anything under `sw/`, press **Reload** on this
extension's card at `chrome://extensions` — the card in the list, not the one
inside *Details*. Chrome sometimes serves a cached service worker; if a change
seems not to apply, bump `version` in `manifest.json` and reload again, then
confirm the new version appears in dsh web's `/chrome/status` as
`extension_version`. Editing the panel's own files needs only that the panel be
closed and reopened.

Tests are split by runner, and `npm run test:all` runs both:

```bash
npm test              # bridge service worker (node:test, tests/)
npm run test:sidepanel  # side panel units (vitest + jsdom, test/)
```

## Expect a debugging banner

While the bridge is attached, Chrome shows a "being debugged" notice, and you
cannot have DevTools open on the same tab. That is inherent to the protocol this
extension uses, not a bug.
