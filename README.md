# DSH Chrome Bridge (browser extension)

Two independent halves share one extension:

1. **The bridge.** Lets a DeepSeek Harness agent drive **this** browser — your
   real profile, your real logins — by executing tool calls forwarded from the
   `/chrome/ws` endpoint of your configured `dsh web` server.
2. **The side panel.** A DSH AI chat that talks to that same server (default
   `http://127.0.0.1:3080`). See [The side panel](#the-side-panel).

Neither half needs the other: the bridge works with the panel closed, and the
panel works whether or not the bridge has managed to connect.

## Install

Run the installer from the root of this repository:

```bash
./install.sh
```

It installs DSH and its plugins, registers the browser launcher, derives the
fixed extension ID from `manifest.json`, and verifies that the launcher can
start `dsh web`. You do not need to copy an extension ID or run a second
script.

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

## Connection status

Open the side panel, press **⋮**, and look under *Agent 浏览器控制* on the
server tab. It reports whether the bridge is currently attached to `dsh web`
and which WebSocket URL it is using.

There is no on/off switch. Agent control is the reason this extension exists, so
a toggle that turns it off only produces a confusing failure mode — an installed
extension that silently refuses to work, usually long after the user has
forgotten they flipped it. To take the browser back, disable or remove the
extension from `chrome://extensions`, or stop `dsh web`; either drops the
connection immediately and no tool call can reach the browser.

(An older build had a **允许 Agent 控制此浏览器** switch backed by a
`dsh_chrome_enabled` storage flag. The flag is now ignored and cleared at
startup, so profiles that had switched it off reconnect after updating.)

There is no popup: the toolbar icon opens the panel, because Chrome gives a
declared `action.default_popup` precedence over `openPanelOnActionClick`, so an
extension cannot have both.

## What it can do

While connected, the agent can navigate, read pages, click, type, screenshot,
select explicitly named local files for page upload, and print to PDF **using your logged-in sessions**. It can also borrow the tab
you are currently viewing. Two of the tools (`mouse_click`, `key_type`) send
*trusted* input, which pages cannot distinguish from your own typing. Local file upload passes paths directly to Chrome DevTools Protocol. A visible trigger is resolved to its file input through standard label/ARIA relationships or a unique containing input; ambiguous controls are rejected rather than guessed.

Treat granting this the way you would treat handing someone your unlocked
laptop. Turn the toggle off when you are done.

## Host operations: Git, plugins, and restarting dsh

The Git entry in the chat area's top-right corner, the install/update/uninstall
buttons on the **插件** tab, and the restart/update buttons under **服务端** all
run real commands on your machine.

The Git entry mirrors the macOS app's toolbar control: it names the current
branch and how much has piled up (`+added −removed`), and opens a popover that
switches branch, creates one, or pushes/pulls. It appears only when the working
directory really is a git repository — a plain directory gets no entry at all,
because everything the entry shows is git state. A branch another worktree has
checked out is listed but greyed, since git would refuse that checkout anyway. An extension cannot start a process, so these go
through `chrome-daemon`'s `/host/*` HTTP routes, which are separate from the
Chrome-control WebSocket — turning host operations off never disturbs browser
control, and vice versa.

What the daemon will run is fixed in its own source, not chosen by the caller:

- **Git** — an allowlist of subcommands (`status`, `log`, `checkout`, `push`, …)
  with options like `-c` and `--upload-pack` rejected, because those make git
  execute arbitrary programs. The working directory must be a registered
  workspace inside your home directory.
- **Plugins** — `dsh plugin` (which forwards to pnpm) restricted to
  `add`/`remove`/`update`/`list`/`outdated`, and only for registry package
  names. `file:`, `link:`, `git+` and `github:` specs are refused, since those
  install from an arbitrary location and run the package's build scripts.
- **The dsh runtime** — restart and update take no arguments at all. Restart
  finds the process by its port and refuses unless that process really is
  `dsh web`; update is hard-coded to `pnpm add -g @deepseek-ai/dsh@latest`.

> **dsh must be installed with pnpm.** These buttons deliberately start and
> restart `$PNPM_HOME/dsh`, never whatever `dsh` happens to come first on
> `PATH`. If a copy installed some other way shadows it, updating would change
> one copy while you keep running the other — the version would never move and
> the update would appear to have worked. When dsh is not a pnpm install, the
> panel says so and points at `pnpm add -g @deepseek-ai/dsh` instead of failing
> vaguely.

### Who is allowed to call these routes

The daemon accepts `/host/*` only from this extension's exact origin, and only
on the loopback interface. That stops web pages (a browser will not let a page
forge an extension origin) and other installed extensions (the id is compared
exactly, not by prefix).

It does **not** stop another program running as you on this machine: any local
process can set an `Origin` header, and a loopback TCP connection carries no
caller identity. This is a deliberate trade-off — such a program can already
run `git` and `pnpm` directly, so these routes do not widen what it could do.
The allowlists above, and the host-proxy kill switch below, are what limit the
damage.

**Kill switch:** **服务端** has *关闭宿主代理*, which disables every `/host/*`
route until the daemon restarts. Browser control keeps working.

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
settings button holds the backend address, the bridge's connection status,
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
              (bridge-settings.js reports the bridge's connection status)
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
