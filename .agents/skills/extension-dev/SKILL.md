---
name: chrome-extension-local-dev
description: Load, reload, open, and debug a local Manifest V3 Chrome extension with Chrome DevTools MCP, configuring the Codex or Claude Code MCP server when extension tools are unavailable. Use when the user asks to install or reload an unpacked extension, open its action, popup, or side panel, or inspect extension pages, service workers, and chrome.storage state.
---

# Chrome Extension Local Dev

Run a deterministic extension development loop against the user's daily Chrome profile or an isolated test Chrome.

## Tool selection

1. Inspect available MCP tools. Require the extension methods needed by the task; generic page tools alone are insufficient.
2. Prefer ready native tools.
3. If required tools are absent, tell the user that this skill is installing the missing MCP server. Use the current host:

```bash
node <skill-dir>/scripts/install-native-mcp.mjs --host codex
node <skill-dir>/scripts/install-native-mcp.mjs --host claude
```

The installer is idempotent and never overwrites an existing entry.

New MCP tools load only in a new session. Tell the user once, continue with the bundled runner, and do not restart the host.

Use `scripts/chrome-devtools-mcp.mjs` when native tools remain unavailable. It exposes one MCP tool call per invocation:

```bash
node <skill-dir>/scripts/chrome-devtools-mcp.mjs <tool-name> '<json-arguments>'
```

Use `--isolated` before the tool name when login state is unnecessary. The default mode reuses the user's daily Chrome.

The default mode routes every call through the long-lived daemon in `scripts/mcp-daemon.mjs`: one `chrome-devtools-mcp` process holds a single browser-level CDP connection, so Chrome's remote-debugging authorization prompt appears only once per daemon lifetime instead of once per tool call. The daemon starts lazily on the first call, exits after 30 minutes idle (`CHROME_DEVTOOLS_MCP_IDLE_MS=0` disables), and lazily restarts after the MCP process dies. Its socket, pid, and log live at `$(TMPDIR)/chrome-devtools-mcp-<uid>.{sock,pid,log}`. Force a clean reconnect (Chrome will authorize once more) with:

```bash
node <skill-dir>/scripts/chrome-devtools-mcp.mjs --shutdown
```

If the matching host CLI is missing, report that native installation was skipped and continue with the bundled runner. Do not edit Codex or Claude configuration files by hand.

## Workflow

### 1. Discover the extension

- Locate `manifest.json`; use its containing directory as the unpacked extension path.
- Read the manifest name and declared extension surfaces.
- Preserve unrelated worktree changes.

### 2. Connect to Chrome

For daily Chrome, configure or invoke Chrome DevTools MCP with:

```text
--categoryExtensions --autoConnect --experimentalIncludeAllPages
```

If it reports a missing `DevToolsActivePort`, prefer using the CU (computer use) tool to help the user complete the enablement — open

```text
chrome://inspect/#remote-debugging
```

and enable “Allow remote debugging for this browser instance”, clicking Allow on the user’s behalf. Only ask the user to do it themselves when CU is unavailable. This is a one-time user-controlled security action; do not bypass it by relaunching or modifying their profile.

Use isolated mode when authentication and existing cookies are not needed. Omit `--autoConnect`; MCP will launch a disposable testing Chrome over a pipe connection.

### 3. Install or reload

1. Call `list_extensions`.
2. Match by exact manifest name. Do not print unrelated installed extensions.
3. If absent, call `install_extension` with the absolute extension directory.
4. If present, call `reload_extension` with its ID.

After every source edit, reload the extension before validation.

### 4. Open an extension surface

- To inspect an extension page as a tab, call `new_page` with:

```text
chrome-extension://<extension-id>/<manifest-page>
```

- For a real action/popup/side-panel interaction, call `trigger_extension_action`.
- A direct `sidepanel.html` tab is appropriate for DOM, console, storage, and visual debugging, but it is not the browser's actual side-panel surface.

### 5. Inspect extension state

- Inspect `chrome.storage` from an extension page when debugging persisted state.
- Use the extension's settings UI to change state when available.
- For deterministic extension checks, use `evaluate_script` only with documented storage keys.
- Discover keys from source; never guess or overwrite unrelated storage.
- Reload the extension page after changing storage.

## Common failures

- Native tools absent but the host entry is configured: continue with the runner and ask the user to start a new task/session.
- Host CLI missing: continue with the runner and report which CLI is missing.
- `DevToolsActivePort` missing: ask the user to enable remote debugging at `chrome://inspect/#remote-debugging`.
- Chrome restarts or the daemon exits idle: the runner restarts the daemon on the next call and Chrome authorizes once more; this is expected, not a regression.
- Daemon socket present but stale: the runner removes the socket file and starts a fresh daemon automatically.
- Extension category unavailable: ensure Chrome 149+ for daily Chrome; otherwise use isolated mode.
- Extension page missing after reload: reopen it using the current extension ID.
- Service worker state disappears: verify persisted state through `chrome.storage`.
