// 移动端访问 pane。版式对齐 macOS 的 MobileAccessSection:三段 ——
//   1. 中转服务:状态点 + 一句话,连上时给红色的「切断」,被主动切断后给「恢复」;
//   2. 已配对的手机:在线灯 / 上次在线,改名与吊销;「添加设备」跟着分组标题走;
//   3. 配对码:一次性二维码 + 复制配对串 + 扫码说明;插件没装时换成一键安装。
//
// 桥接随 dsh server 常驻,这里没有开关。配对串、码的存活、设备在线与否都由
// dsh-mobile-bridge 插件说了算(见 features/mobile-access),这一页只负责画。
//
// 与 Mac 的差别只在能做到的范围:装完插件要重启服务时,Mac 直接重启它托管的
// 进程;这里经 chrome-daemon 重启 dsh web(与服务端页的「重启服务」同一条路),
// 做不到时就地说明"重启后生效"。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import { formatRelativeTime } from "../../../features/sessions/session-row-trailing.js";
import { createMobileAccess, MobilePhase } from "../../../features/mobile-access/mobile-access.js";
import { qrSvg } from "../../../features/mobile-access/qr-svg.js";
import { createPluginManagerService } from "../../../features/settings/plugin-manager-service.js";
import { section, row, button, statusLine, escapeHtml, textInput } from "./settings-ui.js";

/// 手机是在这一页开着的时候扫码的,所以轮询而不是只读一次(与 Mac 同频)。
const POLL_INTERVAL_MS = 3000;
const MINUTE = 60_000;

/// 中转那一行的状态点与文案(Mac MobileAccessSection.dotState / statusText)。
export function relayView(state) {
  switch (state.phase) {
    case MobilePhase.ready:
      if (state.connected) return { kind: "ok", text: t("mob.relayUp") };
      // "故意切断"和"还没连上"是两回事,状态这行也得分开说。
      return { kind: "warn", text: t(state.disabled ? "mob.relayCut" : "mob.relayDown") };
    case MobilePhase.missing: return { kind: "warn", text: t("mob.notInstalled") };
    case MobilePhase.failed: return { kind: "err", text: state.error || t("mob.relayDown") };
    default: return { kind: "busy", text: t("mob.checking") };
  }
}

/// 在线就说在线,不在线就说上次是什么时候 —— 和会话列表用同一套时间刻度。
export function presenceText(device, now = Date.now()) {
  if (device.online) return t("mob.deviceOnline");
  if (now - device.lastSeenAt < MINUTE) return t("mob.deviceJustNow");
  return t("mob.deviceLastSeen", { time: formatRelativeTime(device.lastSeenAt, t, now) });
}

export function createMobilePane({ host, sheet, deps, serverOps }) {
  const access = createMobileAccess({
    connection: deps.connection,
    pluginManager: createPluginManagerService(deps.connection),
    onChange: () => render()
  });
  const state = access.state;
  let timer = null;
  let busy = false;
  let copied = false;
  let copiedTimer = null;
  // 上一次写进 DOM 的 HTML:轮询每 3 秒回一次,内容没变就不重写,
  // 免得用户正按着的按钮、正选中的文字被冲掉。
  let painted = "";

  function relaySection() {
    const view = relayView(state);
    let action = "";
    if (state.phase === MobilePhase.ready && state.connected) {
      action = button({ id: "mob-disconnect", label: t("mob.disconnect"), kind: "danger", disabled: busy });
    } else if (state.phase === MobilePhase.ready && state.disabled) {
      action = button({ id: "mob-connect", label: t("mob.reconnect"), disabled: busy });
    }
    return section({
      body: row({
        label: escapeHtml(t("mob.relay")),
        hint: state.relay ? '<span class="set-mono">' + escapeHtml(state.relay) + "</span>" : "",
        control: '<div class="mob-relay-control"><span id="mob-relay-state">'
          + statusLine(view.text, view.kind) + "</span>" + action + "</div>"
      })
    });
  }

  function deviceRow(device) {
    const id = escapeHtml(device.deviceId);
    return row({
      className: "mob-device",
      label: '<span class="mob-device-name" title="' + escapeHtml(device.label) + '">' + escapeHtml(device.label) + "</span>",
      hint: statusLine(presenceText(device), device.online ? "ok" : "muted"),
      control: '<button class="set-link" type="button" data-mob-rename="' + id + '">' + escapeHtml(t("rename")) + "</button>"
        + '<button class="set-link mob-revoke" type="button" data-mob-revoke="' + id + '">'
        + escapeHtml(t("mob.revoke")) + "</button>"
    });
  }

  function devicesSection() {
    const body = state.devices.length
      ? state.devices.map(deviceRow).join("")
      : '<div class="set-empty">' + escapeHtml(t("mob.noDevices")) + "</div>";
    // 「再加一台」就是这一段的动作,所以按钮跟着标题走,而不是落在下面。
    const headerHtml = '<div class="mob-section-head"><span>' + escapeHtml(t("mob.devices")) + "</span>"
      + button({ id: "mob-add", label: t("mob.addDevice"), disabled: state.phase !== MobilePhase.ready || busy })
      + "</div>";
    return section({ headerHtml, body });
  }

  /// 二维码本体,以及"没有码"的几种说法。
  function codeBlock() {
    // 安装途中服务会重启,状态会短暂报错:整段都只显示进度。
    if (state.installing) return placeholder("loader", t("mob.installing"), "", "");
    switch (state.phase) {
      case MobilePhase.ready: {
        if (state.pairingUrl) {
          let qr = "";
          try { qr = qrSvg(state.pairingUrl, { label: t("mob.pair") }); } catch { qr = ""; }
          return '<div class="mob-qr" id="mob-qr">' + qr + "</div>"
            + '<button class="set-btn with-icon" type="button" id="mob-copy">'
            + lucideIconSvg(copied ? "check" : "copy", { size: 13 })
            + "<span>" + escapeHtml(t(copied ? "mob.copied" : "mob.copyPairing")) + "</span></button>"
            + '<div class="mob-hint">' + escapeHtml(t("mob.scanHint")) + "</div>"
            // 中转是大家共用的,手机上认的是这台电脑的名字。
            + (state.deviceName ? '<div class="mob-caption">' + escapeHtml(t("mob.thisComputer", { name: state.deviceName })) + "</div>" : "")
            + (state.connected ? "" : '<div class="mob-caption faint">' + escapeHtml(t("mob.offline")) + "</div>");
        }
        // 桥接不再给码,说明它被扫走或已过期:给个动作,别一直转圈。
        return placeholder("smartphone", t("mob.pair"), t("mob.codeGone"),
          button({ id: "mob-new-code", label: t("mob.newCode"), disabled: busy }));
      }
      case MobilePhase.missing: {
        const failure = state.installError === "restart-required"
          ? '<div class="set-warn">' + escapeHtml(t("mob.restartRequired")) + "</div>"
          : state.installError ? '<div class="set-danger mob-error">' + escapeHtml(state.installError) + "</div>" : "";
        return placeholder("smartphone", t("set.tab.mobile"), t("mob.pluginMissing"),
          failure + button({ id: "mob-install", label: t("mob.installPlugin"), kind: "primary" }));
      }
      case MobilePhase.failed:
        return placeholder("circle-alert", t("set.tab.mobile"), state.error, "");
      default:
        return placeholder("loader", "", "", "");
    }
  }

  function placeholder(icon, title, description, actions) {
    const glyph = icon === "loader"
      ? '<span class="set-spinner" role="status" aria-label="' + escapeHtml(title || t("mob.checking")) + '"></span>'
      : lucideIconSvg(icon, { size: 28 });
    return '<div class="mob-placeholder">'
      + '<div class="mob-placeholder-icon">' + glyph + "</div>"
      + (title ? '<div class="mob-placeholder-title">' + escapeHtml(title) + "</div>" : "")
      + (description ? '<div class="mob-placeholder-text">' + escapeHtml(description) + "</div>" : "")
      + (actions ? '<div class="mob-placeholder-actions">' + actions + "</div>" : "")
      + "</div>";
  }

  function render() {
    const html = relaySection() + devicesSection()
      + section({ body: '<div class="mob-pair" id="mob-pair">' + codeBlock() + "</div>" });
    if (html === painted) return;
    painted = html;
    host.innerHTML = html;
    bind();
  }

  /// 按钮动作的公共外壳:期间禁用同组按钮,结束后由 onChange 重画。
  async function run(action) {
    if (busy) return;
    busy = true;
    render();
    try { await action(); } finally { busy = false; render(); }
  }

  function bind() {
    host.querySelector("#mob-disconnect")?.addEventListener("click", () => run(() => access.disconnect()));
    host.querySelector("#mob-connect")?.addEventListener("click", () => run(() => access.connect()));
    host.querySelector("#mob-add")?.addEventListener("click", () => run(() => access.pair()));
    host.querySelector("#mob-new-code")?.addEventListener("click", () => run(() => access.pair()));
    host.querySelector("#mob-install")?.addEventListener("click", () => access.install({ restart: restartServer }));
    host.querySelector("#mob-copy")?.addEventListener("click", copyPairing);
    for (const link of host.querySelectorAll("[data-mob-rename]")) {
      link.addEventListener("click", () => {
        const device = state.devices.find((entry) => entry.deviceId === link.dataset.mobRename);
        if (device) openRename(device);
      });
    }
    for (const link of host.querySelectorAll("[data-mob-revoke]")) {
      link.addEventListener("click", () => run(() => access.revoke(link.dataset.mobRevoke)));
    }
  }

  async function copyPairing() {
    if (!state.pairingUrl) return;
    try {
      await navigator.clipboard.writeText(state.pairingUrl);
    } catch {
      return;
    }
    copied = true;
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied = false; render(); }, 1500);
  }

  /// 装完插件、宿主说要重启时用:经 chrome-daemon 重启 dsh web。
  /// 返回 false = 这台机器上重启不了(daemon 没跑 / 太老),由界面说"重启后生效"。
  async function restartServer() {
    if (!serverOps) return false;
    try {
      const result = await serverOps.restart();
      return Boolean(result?.started);
    } catch {
      return false;
    }
  }

  /// 改名面板:预填、聚焦全选、回车提交、Esc 取消;失败原地解释,不关面板
  /// (Mac MobileDeviceRenameSheet 的配方)。名字只是这台电脑给设备起的备注,
  /// 授权只认 deviceId。
  function openRename(device) {
    let saving = false;
    const actions = () => button({ id: "mob-rename-cancel", label: t("set.cancel"), disabled: saving })
      + button({ id: "mob-rename-save", label: t("rename"), kind: "primary", disabled: saving });
    const token = sheet.open({
      title: t("mob.renameTitle"),
      body: textInput({ id: "mob-rename-input", value: device.label, placeholder: t("mob.deviceName") })
        + '<div class="set-danger mob-rename-error" id="mob-rename-error"></div>',
      actions: actions(),
      bind: (root, generation) => {
        const input = root.querySelector("#mob-rename-input");
        const errorSlot = root.querySelector("#mob-rename-error");
        const sync = () => {
          const name = input.value.trim();
          const save = root.querySelector("#mob-rename-save");
          if (save) save.disabled = saving || !name || name === device.label;
        };
        const bindActions = () => {
          root.querySelector("#mob-rename-cancel")?.addEventListener("click", () => sheet.close(generation));
          root.querySelector("#mob-rename-save")?.addEventListener("click", submit);
          sync();
        };
        async function submit() {
          const name = input.value.trim();
          if (saving || !name) return;
          if (name === device.label) { sheet.close(generation); return; }
          saving = true;
          sheet.setActions(actions(), generation);
          bindActions();
          errorSlot.textContent = "";
          const result = await access.rename(device.deviceId, name);
          if (!sheet.owns(generation)) return;
          if (result.outcome === "renamed") { sheet.close(generation); return; }
          saving = false;
          errorSlot.textContent = result.outcome === "unsupported"
            ? t("mob.renameUnsupported")
            : result.message || t("mob.renameFailed");
          sheet.setActions(actions(), generation);
          bindActions();
        }
        input.addEventListener("input", () => { errorSlot.textContent = ""; sync(); });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); }
        });
        bindActions();
        input.focus();
        input.select();
      }
    });
    return token;
  }

  async function refresh() {
    // 重新进这一页先画一次手头的状态,再去读;轮询只在这一页可见时跑。
    painted = "";
    render();
    await access.refresh();
    // 桥接还留着一张有效的码就接着用它:重开这一页不该把上一张作废。
    if (state.phase === MobilePhase.ready && !state.pairingUrl) await access.pair();
    if (!timer) timer = setInterval(() => { access.refresh(); }, POLL_INTERVAL_MS);
  }

  return {
    refresh,
    /// 离开这一页时停表:码不可见就不该继续每 3 秒问一次桥接。
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
