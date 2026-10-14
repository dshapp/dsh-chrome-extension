// 服务端 pane。版式对齐 macOS 的 ServerSettingsSection:一条更新横幅 +
// 一组服务信息(状态 / 版本 / 地址 / 主目录 / 日志)+ 末尾的重启。
//
// 与 Mac 的差别只在能做到的范围:那边能重启 App 本体,扩展不能起进程,
// 所以末段只重启 dsh web,文案也如实写成「重启服务」。
//
// 这一页刻意**不**提供后端地址输入框与宿主代理开关:版式以视觉稿为准。
// 本地启动器则补了一行 —— 装了但没跑起来时,用户需要有个地方能让它再试一次,
// 而启动器只在 dsh 启动时由插件注册,管不了"现在没起来"。
//
// 「服务地址」是只读的一行,这一点不只是版式取舍 —— 它的权威方向常被记反:
// 地址的源头是**扩展**(settings.getBackendUrl,默认 127.0.0.1:3080),
// native-supervisor 把它当参数**发给** native host,host 再拿它去 probe 端口、
// 拼 `dsh web --host/--port`。host 的 status 回包里根本没有地址(只有 logDir
// 与 dsh 路径;那个 `host` 字段是 native-host 的名字 "com.dsh.chrome",
// 不是网络主机名,当地址读会错得很隐蔽)。
//
// 所以这里显示的就是本扩展自己要连的那个地址,不是宿主自报的事实。
import { validateUpdateTarget } from "../../../features/host-proxy/version.js";
import { t } from "../../../shared/i18n.js";
import { section, row, button, statusLine, escapeHtml } from "./settings-ui.js";
import { RPC } from "../../../platform/dsh/rpc-methods.js";
import { probeHost } from "../../../platform/dsh/native-supervisor.js";
import { createBridgeStatus } from "../bridge-settings.js";
import { createServerLauncherRow } from "./server-launcher-row.js";

/// 每秒复查一次连接状态。与 header 状态点同频:重连是后台发生的,
/// 页面开着时状态必须自己走,而不是等用户切 tab 才更新。
const POLL_INTERVAL_MS = 1000;

/// 下行流三态 → 状态点配色与文案。三态是真实存在的:重连期间是"连接中"
/// (黄、脉冲),把它和"未连接"混为一谈会让正在恢复的连接看起来像挂了。
function connectionView(streamState, DshStreamState) {
  if (streamState === DshStreamState.CONNECTED) return { kind: "ok", text: t("srv.connected") };
  if (streamState === DshStreamState.CONNECTING) return { kind: "busy", text: t("srv.connecting") };
  return { kind: "err", text: t("srv.disconnected") };
}

export function createServerPane({ host, deps, showToast, serverOps }) {
  let hostInfo = null;
  let timer = null;
  // CDP 桥的状态。由 createBridgeStatus 轮询,变化时只重画那一行 ——
  // 整页重画会把用户正按着的按钮换掉。
  let bridge = null;
  const bridgeStatus = createBridgeStatus({
    onChange: (next) => {
      // 行在不在,取决于 available;它一变就得整页重画,因为要新增/移除一整行。
      // 之后的连接态变化只补那一行 —— 整页重画会把用户正按着的按钮换掉。
      const appeared = Boolean(next?.available) !== Boolean(bridge?.available);
      bridge = next;
      if (appeared) render();
      else paintBridge();
    }
  });
  // 启动器自报的 logDir / dsh 路径。只 probe(cmd:"status"),不会拉起任何进程。
  let launcher = null;
  // dsh 本体的版本 / 重启 / 更新。经 chrome-daemon 执行 —— 扩展起不了进程,
  // 而 dsh web 自己没有 shutdown/restart 接口(实测 /shutdown 回 405)。
  //
  // null 表示还没查过;dshUnsupported 表示这台机器上做不了(daemon 太老、
  // 没跑,或 dsh 不是用 pnpm 装的),此时相关行不渲染而不是画点不动的按钮。
  let dsh = null;
  let dshUnsupported = false;
  let dshBusy = null;
  let dshChannel = "latest";
  let dshExact = "";
  let dshTargetLoading = false;
  function selectedTarget() { return dshChannel === "exact" ? dshExact : dshChannel; }
  // 更新与重启的结果就地显示,而不是只弹一次 toast:失败原因要留在按下的
  // 那个控件旁边(对齐 Mac 的 restartError / updateError / updateDone)。
  let dshRestartError = null;
  let dshUpdateError = null;
  let dshUpdateDone = false;
  const launcherRow = createServerLauncherRow({
    showToast,
    formatErrorDetails: (error) => deps.formatErrorDetails?.(error) ?? String(error),
    onChange: () => render()
  });
  let refreshGeneration = 0;
  let dshLoadGeneration = 0;

  function currentView() {
    return connectionView(deps.connection.streamState, deps.DshStreamState);
  }

  /// 状态行右侧:只有状态点 + 三态文案,没有来源说明。
  ///
  /// 曾经在后面缀一句「—— 复用了已在运行的服务」。去掉了:那讲的是**本次**是
  /// 谁把服务拉起来的,而这一行要回答的是"现在通不通"。两件事挤在一行里,
  /// 读的人得先分辨哪半句在说当下 —— 而且那半句的依据只是"启动器装着",
  /// 并不能真的区分服务是被复用还是被本扩展启动的。
  function connectionControl() {
    const view = currentView();
    return statusLine(view.text, view.kind);
  }

  function connectionRow() {
    return row({
      label: escapeHtml(t("srv.stateLabel")),
      control: '<span id="srv-state">' + connectionControl() + '</span>'
    });
  }

  /// 只改状态点那一小块,不重画整页 —— 每秒重写 innerHTML 会让按钮失焦。
  function paintConnection() {
    const slot = host.querySelector("#srv-state");
    if (!slot) return;
    slot.innerHTML = connectionControl();
  }

  /// 更新横幅。对齐 Mac 的 showsUpdateRow:发现新版前不出现,之后一直保留到
  /// 安装完成或失败,让进度与结果留在动作旁边,而不是弹一个 toast 就消失。
  function showsUpdateRow() {
    return Boolean(dsh?.updatable) || (dsh?.updateSupported && dshChannel !== "latest" && dsh?.targetVersion)
      || dshBusy === "update" || dshUpdateDone || dshUpdateError;
  }

  function updateRow() {
    if (!showsUpdateRow()) return "";
    const label = dshUpdateDone
      ? '<span class="set-ok">' + escapeHtml(t("srv.dshUpdated")) + '</span>'
      : '<span class="set-warn">' + escapeHtml(t("srv.dshUpdateAvailable")) + '</span>';
    // 版本对进 hint 位(标签下方的等宽小字),与稿一致。
    // 早先它是嵌在 label 里的一个 .set-row-hint <div> —— 一个块级提示套在
    // 行标签内部,既错位也让 ".set-row-label .set-row-hint" 这种选择器意外命中。
    const versions = dsh?.current && dsh?.targetVersion
      ? '<span class="set-mono">' + escapeHtml(dsh.current) + ' → ' + escapeHtml(dsh.targetVersion) + '</span>'
      : "";
    const failure = dshUpdateError
      ? '<div class="set-danger">' + escapeHtml(dshUpdateError) + '</div>'
      : "";
    return section({
      body: row({
        label,
        hint: versions + failure + (dsh?.downgrade ? '<div class="set-warn">' + escapeHtml(t("srv.updateDowngrade")) + "</div>" : ""),
        control: button({
          id: "srv-dsh-update",
          label: dshBusy === "update" ? t("srv.dshUpdating") : t("srv.dshUpdate"),
          kind: "primary",
          // 完成后禁用:同一个版本没有再装一次的意义(Mac 同样在 updateDone 后禁用)。
          disabled: Boolean(dshBusy) || dshTargetLoading || dshUpdateDone || !dsh?.targetVersion
            || (dshChannel !== "latest" && !dsh?.updateSupported)
        })
      })
    });
  }

  /// CDP 桥那一行的右侧内容。
  ///
  /// 两态:连上了(ok)/ 还没连上(busy)。没有 err 档 —— 那一档过去表示
  /// "用户主动关掉了",而开关已经删掉,现在关不掉了。没连上一律算"正在等",
  /// 因为桥会一直重试(background 的 RECONCILE_ALARM 每 30s)。
  function bridgeControl() {
    if (!bridge?.available) return "";
    return bridge.connected
      ? statusLine(t("bridge.connected"), "ok")
      : statusLine(t("bridge.disconnected"), "busy");
  }

  /// 桥行的副标题:连上了报 daemon 地址,没连上给出排查方向。
  function bridgeHint() {
    if (!bridge?.available) return "";
    return escapeHtml(bridge.connected
      ? t("bridge.daemonAt", { url: bridge.url ?? "" })
      : t("bridge.waiting"));
  }

  /// 只重画桥那一行,不动整页(与 paintConnection 同样的理由)。
  function paintBridge() {
    const slot = host.querySelector("#set-bridge-state");
    if (!slot) return;
    slot.innerHTML = bridgeControl();
    const hint = host.querySelector("#set-bridge-detail");
    if (hint) hint.innerHTML = bridgeHint();
  }

  /// 服务信息组:状态 / 服务版本 / 服务地址 / Harness 主目录 / 日志 / Agent 浏览器控制。
  ///
  /// 每一行的数据都可能缺席(没连上、daemon 太老、启动器没装),缺的那行整行
  /// 不画 —— 画一个空值行只是在问用户"这里本来该有什么"。
  function infoSection() {
    const rows = [connectionRow()];

    // 「DSH 包」一行把两处事实并在一起:版本来自 pnpm(serverOps.version),
    // 路径来自 native host 的 status(dsh 可执行文件)。分开画两行的话,
    // 用户得自己把"版本"和"哪个 dsh"对上,而那正是这句话要回答的问题。
    if (dsh?.current || launcher?.dsh) {
      rows.push(row({
        label: escapeHtml(t("srv.dshPackage")),
        hint: launcher?.dsh
          ? '<span class="set-mono">' + escapeHtml(launcher.dsh) + '</span>'
          : escapeHtml(t("srv.dshVersionHint")),
        control: dsh?.current
          ? '<span class="set-mono">' + escapeHtml(dsh.current) + '</span>'
          : ""
      }));
    }

    // 地址是可点的:它就是要连的那个服务,点开即在新标签里看真实界面 ——
    // 侧栏里再放一个"打开"按钮只是同一件事多一个按钮。
    const url = deps.connection.baseUrl;
    if (url) {
      rows.push(row({
        label: escapeHtml(t("srv.serverUrl")),
        control: '<a class="set-link srv-url" href="' + escapeHtml(url) + '"'
          + ' target="_blank" rel="noreferrer noopener">' + escapeHtml(url) + '</a>'
      }));
    }

    if (hostInfo?.home) {
      rows.push(row({
        label: escapeHtml(t("srv.harnessHome")),
        control: button({ id: "srv-reveal-home", label: t("srv.revealInFinder"), kind: "plain" })
      }));
    }

    // 日志行的路径落在 hint 位(标签底下、等宽灰字),与稿一致 ——
    // 它比按钮长得多,挤到右侧尾随位置会把按钮推出可视区。
    if (launcher?.logDir) {
      rows.push(row({
        label: escapeHtml(t("srv.logs")),
        hint: '<span class="set-mono">' + escapeHtml(logPath()) + '</span>',
        control: button({ id: "srv-view-log", label: t("srv.viewLog"), kind: "plain" })
      }));
    }

    // Agent 浏览器控制:并进这张卡的最后一行,而不是自己单独占一张只有一行的卡。
    // 这个部署里没有桥半部时整行不画 —— 画一盏永远不亮的灯只会让人以为坏了。
    if (bridge?.available) {
      rows.push(row({
        label: escapeHtml(t("settings.bridge")),
        hint: '<span id="set-bridge-detail">' + bridgeHint() + '</span>',
        control: '<span id="set-bridge-state">' + bridgeControl() + '</span>'
      }));
    }

    return section({ body: rows.join("") });
  }

  /// 启动器把 dsh web 的 stdout/stderr 都写进 logDir/dsh-web.log(见
  /// native-host 的 startWeb),所以这里按同一个约定拼,而不是另找一个路径。
  function logPath() {
    const dir = String(launcher?.logDir ?? "").replace(/[/]+$/, "");
    return dir ? dir + "/dsh-web.log" : "";
  }

  /// 重启段。标题 + 说明 + 橙色警告 + 失败就地显示(对齐 Mac 的 restartRow)。
  /// 警告不能只放在 toast 里 —— 用户是在按下之前需要知道"这会中断会话"。
  function restartSection() {
    if (!serverOps || dshUnsupported) return "";
    const hint = escapeHtml(t("srv.restartDesc"))
      + '<div class="set-warn">' + escapeHtml(t("srv.restartWarn")) + '</div>'
      + (dshRestartError ? '<div class="set-danger">' + escapeHtml(dshRestartError) + '</div>' : "");
    return section({
      body: row({
        label: escapeHtml(t("srv.restartTitle")),
        hint,
        control: button({
          id: "srv-dsh-restart",
          label: dshBusy === "restart" ? t("srv.dshRestarting") : t("srv.restartTitle"),
          kind: "danger",
          disabled: Boolean(dshBusy)
        })
      })
    });
  }

  function updateTargetSection() {
    if (!dsh || dshUnsupported) return "";
    const disabled = Boolean(dshBusy) || !dsh.updateSupported;
    const options = ["latest", "next", "alpha", "exact"].map((value) => {
      const version = dsh.distTags?.[value];
      const label = value === "exact" ? t("srv.updateExactLabel") : value + (version ? " · " + version : "");
      return '<option value="' + value + '"' + (dshChannel === value ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
    }).join("");
    const control = '<select id="srv-dsh-channel" aria-label="' + escapeHtml(t("srv.updateChannelLabel")) + '"' + (disabled ? " disabled" : "") + '>' + options + '</select>';
    const exact = dshChannel === "exact" ? row({ label: escapeHtml(t("srv.updateExactLabel")),
      control: '<input id="srv-dsh-exact" aria-label="' + escapeHtml(t("srv.updateExactLabel")) + '" value="' + escapeHtml(dshExact) + '" placeholder="' + escapeHtml(t("srv.updateExactPlaceholder")) + '"' + (disabled ? " disabled" : "") + '>' }) : "";
    const hint = !dsh.updateSupported ? t("srv.updateProtocolUnsupported")
      : dshTargetLoading ? t("srv.dshChecking") : dsh.checkFailed ? t("srv.updateTargetUnavailable") : "";
    return section({ body: row({ label: escapeHtml(t("srv.updateChannelLabel")), hint: escapeHtml(hint), control }) + exact });
  }
  function render() {
    host.innerHTML = updateTargetSection() + updateRow() + infoSection() + launcherRow.render() + restartSection();
    bind();
  }

  function bind() {
    host.querySelector("#srv-dsh-channel")?.addEventListener("change", (event) => {
      if (dshBusy || !dsh?.updateSupported) return;
      dshChannel = event.target.value;
      changeTarget();
    });
    host.querySelector("#srv-dsh-exact")?.addEventListener("change", (event) => {
      if (dshBusy) return;
      dshExact = event.target.value;
      changeTarget();
    });
    host.querySelector("#srv-dsh-restart")?.addEventListener("click", () => runDshAction("restart"));
    host.querySelector("#srv-dsh-update")?.addEventListener("click", () => runDshAction("update"));
    launcherRow.bind(host);
    host.querySelector("#srv-reveal-home")?.addEventListener("click", () => openPath(hostInfo?.home));
    host.querySelector("#srv-view-log")?.addEventListener("click", () => openPath(logPath()));
  }

  /// 用宿主的默认方式打开一个路径(Finder / 默认编辑器)。
  ///
  /// 走 host.openPath 而不是 window.open:侧栏是扩展页,file: URL 打不开,
  /// 而这条 RPC 本来就是给"用系统打开工作目录"用的同一条路。
  async function openPath(path) {
    if (!path) return;
    try {
      await deps.connection.call(RPC.hostOpenPath, { request: { path } });
    } catch (error) {
      showToast?.(deps.formatErrorDetails?.(error) ?? t("srv.openFailed"));
    }
  }

  /// 重启或更新 dsh。
  ///
  /// 重启会断开当前连接,所以完成后不做任何"回到原样"的假设 —— 连接态由
  /// paintConnection 每秒自刷,自己会走回 connected。
  ///
  /// 更新成功后**不自动重启**:那会打断用户正在进行的会话,所以只提示"需重启
  /// 生效",由用户自己按下重启。
  async function runDshAction(kind) {
    if (dshBusy || (kind === "update" && (dshTargetLoading || !dsh?.targetVersion || dshUpdateDone))) return;
    const target = selectedTarget();
    if (kind === "update" && dshChannel !== "latest" && !dsh?.updateSupported) return;
    dshBusy = kind;
    if (kind === "restart") dshRestartError = null;
    else { dshUpdateError = null; dshUpdateDone = false; }
    render();
    try {
      if (kind === "restart") {
        const result = await serverOps.restart();
        // started:false 表示进程起了但端口没就绪 —— 此时日志路径比一句失败有用,
        // 所以它进的是就地显示的错误位,不是一闪而过的 toast。
        if (result?.started) showToast?.(t("srv.dshRestarted"));
        else dshRestartError = t("srv.dshRestartLog", { log: result?.log ?? "" });
      } else {
        await serverOps.update(target);
        dshUpdateDone = true;
        showToast?.(t("srv.dshUpdated"));
      }
      // 重启落地后重新查版本(对齐 Mac 的 onChange(phase) → running):
      // 装完再重启的话,这里报的才是真正在跑的那个版本。
      await loadDsh();
    } catch (error) {
      // dsh 不是 pnpm 装的:给出可执行的下一步,而不是一句失败。
      const message = serverOps.isNotPnpmInstall?.(error)
        ? t("srv.dshNotPnpm")
        : (error?.message || String(error));
      if (error?.isUnsupported) {
        dshUnsupported = true;
        showToast?.(t("host.unsupported"));
      } else if (kind === "restart") {
        dshRestartError = message;
      } else {
        dshUpdateError = message;
      }
    } finally {
      dshBusy = null;
      render();
    }
  }

  /// 查一次 dsh 版本。查不到远端版本不算失败(离线是常态)。
  function changeTarget() {
    dshUpdateDone = false;
    dshUpdateError = null;
    dsh = { ...dsh, targetVersion: null, updatable: false, checkFailed: true };
    try { validateUpdateTarget(selectedTarget()); }
    catch (error) { dshLoadGeneration++; dshTargetLoading = false; dshUpdateError = error.message; render(); return; }
    loadDsh();
  }
  async function loadDsh() {
    if (!serverOps) return;
    const generation = ++dshLoadGeneration;
    const target = selectedTarget();
    dshTargetLoading = true;
    render();
    try {
      const next = await serverOps.version(target);
      if (generation !== dshLoadGeneration) return;
      dsh = next;
      dshUnsupported = false;
    } catch (error) {
      if (generation !== dshLoadGeneration) return;
      if (dsh) { dsh = { ...dsh, targetVersion: null, updatable: false, checkFailed: true }; dshUpdateError = error?.message || String(error); }
      else dshUnsupported = true;
      // 老 daemon / 没跑 / 不是 pnpm 装的 → 相关行不显示,不打扰用户。
    }
    dshTargetLoading = false;
    render();
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    let nextHostInfo;
    try {
      nextHostInfo = deps.sessions?.hostHome ? { home: deps.sessions.hostHome } : null;
    } catch {
      // 没连上:主目录行不画。这不是错误,页面顶部的状态行已经说明了。
      nextHostInfo = null;
    }
    // 只 probe 状态,不拉起进程 —— 打开设置页不该有副作用。
    const nextLauncher = await probeHost().catch(() => null);
    if (generation !== refreshGeneration) return;
    hostInfo = nextHostInfo;
    launcher = nextLauncher;
    launcherRow.setStatus(nextLauncher);
    render();
    if (!timer) timer = setInterval(paintConnection, POLL_INTERVAL_MS);
    // 桥自己按秒轮询 service worker;首次结果回来时 onChange 会触发一次重画。
    bridgeStatus.start();
    // 版本查询要跑子进程(dsh --version + pnpm view),比较慢,所以不阻塞首屏。
    loadDsh();
  }

  return {
    refresh,
    /// 离开服务端页时停表:状态点不可见就不该继续跑。
    /// 桥的轮询会唤醒 service worker,更不能留着。
    stop() {
      refreshGeneration += 1;
      dshLoadGeneration += 1;
      if (timer) clearInterval(timer);
      timer = null;
      bridgeStatus.stop();
    }
  };
}
