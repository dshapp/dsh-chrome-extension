// 服务端 pane。版式对齐 macOS 的 ServerSettingsSection:一条更新横幅 +
// 一组服务信息(状态 / 版本 / 地址 / 主目录 / 日志)+ 末尾的重启。
//
// 与 Mac 的差别只在能做到的范围:那边能重启 App 本体,扩展不能起进程,
// 所以末段只重启 dsh web,文案也如实写成「重启服务」。重启本身由本地启动器
// (Native Messaging)执行,做法同 Mac:按端口找到 dsh web,停掉,再在同一地址
// 起新的;启动器太老时退回 chrome-daemon。重启完立刻重连,不等退避。
//
// 这一页刻意**不**提供后端地址输入框与宿主代理开关:版式以视觉稿为准。
// 本地启动器则补了一行,只展示它注册好了没有:dsh web 没起来由后台自动拉起,
// 要换新服务用末段的「重启服务」,这一行不再放启动按钮。
//
// 「服务地址」是只读的一行,这一点不只是版式取舍 —— 它的权威方向常被记反:
// 地址的源头是**扩展**(settings.getBackendUrl,默认 127.0.0.1:3080),
// native-supervisor 把它当参数**发给** native host,host 再拿它去 probe 端口、
// 拼 `dsh web --host/--port`。host 的 status 回包里根本没有地址(只有 logDir
// 与 dsh 路径;那个 `host` 字段是 native-host 的名字 "com.dsh.chrome",
// 不是网络主机名,当地址读会错得很隐蔽)。
//
// 所以这里显示的就是本扩展自己要连的那个地址,不是宿主自报的事实。
import { t } from "../../../shared/i18n.js";
import { section, row, button, statusLine, escapeHtml } from "./settings-ui.js";
import { RPC } from "../../../platform/dsh/rpc-methods.js";
import { probeHost } from "../../../platform/dsh/native-supervisor.js";
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

export function createServerPane({ host, deps, showToast, serverOps, probe = probeHost }) {
  let hostInfo = null;
  let timer = null;
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
  // 更新与重启的结果就地显示,而不是只弹一次 toast:失败原因要留在按下的
  // 那个控件旁边(对齐 Mac 的 restartError / updateError / updateDone)。
  let dshRestartError = null;
  let dshUpdateError = null;
  let dshUpdateDone = false;
  const launcherRow = createServerLauncherRow();
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
  ///
  /// 没有"更新渠道"选择:目标版本由 serverOps.version 按 Mac 的规则自动选出
  /// (next / alpha 中较高者),用户只需决定"更"还是"不更"。
  function showsUpdateRow() {
    return Boolean(dsh?.updatable) || dshBusy === "update" || dshUpdateDone || Boolean(dshUpdateError);
  }

  function updateRow() {
    if (!showsUpdateRow()) return "";
    // 标题即发布日志的链接(对齐 Mac:有发布页时「有新版本」本身可点)。
    const title = escapeHtml(t("srv.dshUpdateAvailable"));
    const label = dshUpdateDone
      ? '<span class="set-ok">' + escapeHtml(t("srv.dshUpdated")) + '</span>'
      : dsh?.releaseUrl
        ? '<a class="set-link srv-release-notes" href="' + escapeHtml(dsh.releaseUrl) + '" target="_blank"'
          + ' rel="noreferrer noopener" title="' + escapeHtml(t("srv.dshReleaseNotes")) + '">' + title + '</a>'
        : '<span class="set-warn">' + title + '</span>';
    // 版本对进 hint 位(标签下方的等宽小字),与稿一致。装完后不再显示:
    // 那时这一行只剩"重启以生效"一件事(Mac 同样只留成功文案)。
    const versions = !dshUpdateDone && dsh?.current && dsh?.targetVersion
      ? '<span class="set-mono">' + escapeHtml(dsh.current) + ' → ' + escapeHtml(dsh.targetVersion) + '</span>'
      : "";
    const failure = dshUpdateError && !dshUpdateDone
      ? '<div class="set-danger">' + escapeHtml(dshUpdateError) + '</div>'
      : "";
    // 装完之后按钮换成重启 —— 新版本要重启才生效,而重启正是用户下一步要做的事
    // (对齐 Mac:updateDone 后更新行的动作变成与下方相同的重启)。
    const control = dshUpdateDone
      ? button({
        id: "srv-dsh-update-restart",
        label: dshBusy === "restart" ? t("srv.dshRestarting") : t("srv.restartTitle"),
        kind: "danger",
        disabled: Boolean(dshBusy)
      })
      : button({
        id: "srv-dsh-update",
        label: dshBusy === "update" ? t("srv.dshUpdating") : t("srv.dshUpdate"),
        kind: "primary",
        disabled: Boolean(dshBusy) || !dsh?.updateTarget
      });
    return section({ body: row({ label, hint: versions + failure, control }) });
  }

  /// 服务信息组:状态 / DSH 包 / 服务地址 / Harness 主目录 / 日志。
  /// Agent 浏览器控制(CDP 桥)的状态灯在浏览器页(browser-pane.js)。
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
        control: button({ id: "srv-reveal-home", label: t(revealLabelKey()), kind: "plain" })
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

    return section({ body: rows.join("") });
  }

  /// 启动器把 dsh web 的 stdout/stderr 都写进 logDir/dsh-web.log(见
  /// native-host 的 startWeb),所以这里按同一个约定拼,而不是另找一个路径。
  function logPath() {
    const raw = String(launcher?.logDir ?? "");
    // Windows 宿主回的是 "C:\…\chrome-native-host":沿用它自己的分隔符,别拼出半边斜杠。
    const sep = /^[A-Za-z]:\\|^\\\\/.test(raw) ? "\\" : "/";
    const dir = raw.replace(/[\\/]+$/, "");
    return dir ? dir + sep + "dsh-web.log" : "";
  }

  /// 「查看主目录」按钮跟系统叫法走:macOS 是 Finder,Windows 是资源管理器。
  function revealLabelKey() {
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    if (/mac/i.test(platform)) return "srv.revealInFinder";
    if (/win/i.test(platform)) return "srv.revealInExplorer";
    return "srv.revealInFolder";
  }

  /// 本地启动器自己就能重启(新版宿主在 status 里声明 restart 命令)。
  /// 这时重启不依赖 chrome-daemon,daemon 缺席或太老也照样给这一段。
  function launcherCanRestart() {
    return launcher?.ok === true && Array.isArray(launcher.commands) && launcher.commands.includes("restart");
  }

  /// 重启段。标题 + 说明 + 橙色警告 + 失败就地显示(对齐 Mac 的 restartRow)。
  /// 警告不能只放在 toast 里 —— 用户是在按下之前需要知道"这会中断会话"。
  function restartSection() {
    if (!serverOps || (dshUnsupported && !launcherCanRestart())) return "";
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

  function render() {
    host.innerHTML = updateRow() + infoSection() + launcherRow.render() + restartSection();
    bind();
  }

  function bind() {
    host.querySelector("#srv-dsh-restart")?.addEventListener("click", () => runDshAction("restart"));
    host.querySelector("#srv-dsh-update")?.addEventListener("click", () => runDshAction("update"));
    host.querySelector("#srv-dsh-update-restart")?.addEventListener("click", () => runDshAction("restart"));
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
    if (dshBusy || (kind === "update" && (!dsh?.updateTarget || dshUpdateDone))) return;
    const target = dsh?.updateTarget;
    dshBusy = kind;
    if (kind === "restart") dshRestartError = null;
    else { dshUpdateError = null; dshUpdateDone = false; }
    render();
    try {
      if (kind === "restart") {
        const result = await serverOps.restart();
        // started:false 表示进程起了但端口没就绪 —— 此时日志路径比一句失败有用,
        // 所以它进的是就地显示的错误位,不是一闪而过的 toast。
        if (result?.started) {
          showToast?.(t("srv.dshRestarted"), "success");
          // 新服务已经在听了:立刻重连,而不是等下行流的退避计时器(对齐 Mac
          // 重启后马上重新接上)。旧连接的会话状态由重连后的快照纠正。
          deps.connection.restart?.();
          // 重启落地后重新查版本(对齐 Mac 的 .task(id: currentDshVersion)):
          // 装完再重启的话,这里报的才是真正在跑的那个版本,更新行也随之复位。
          dshUpdateDone = false;
          dshUpdateError = null;
          await loadDsh();
        } else {
          dshRestartError = t("srv.dshRestartLog", { log: result?.log ?? "" });
        }
      } else {
        // 装的是检查时选定的那个确切版本,不是渠道名 —— 免得检查与安装之间
        // dist-tag 前进,装上一个用户没看过的版本。
        await serverOps.update(target);
        dshUpdateDone = true;
        showToast?.(t("srv.dshUpdated"), "success");
      }
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

  /// 查一次 dsh 版本。查不到远端版本不算失败(离线是常态):不显示更新行即可。
  async function loadDsh() {
    if (!serverOps) return;
    const generation = ++dshLoadGeneration;
    try {
      const next = await serverOps.version();
      if (generation !== dshLoadGeneration) return;
      dsh = next;
      dshUnsupported = false;
    } catch {
      if (generation !== dshLoadGeneration) return;
      // 老 daemon / 没跑 / 不是 pnpm 装的 → 相关行不显示,不打扰用户。
      // 已查到过的话只丢掉更新目标:留着它就是在用一次失败的检查宣传更新。
      if (dsh) dsh = { ...dsh, targetVersion: null, updateTarget: null, updatable: false, releaseUrl: null, checkFailed: true };
      else dshUnsupported = true;
    }
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
    const nextLauncher = await probe().catch(() => null);
    if (generation !== refreshGeneration) return;
    hostInfo = nextHostInfo;
    launcher = nextLauncher;
    launcherRow.setStatus(nextLauncher);
    render();
    if (!timer) timer = setInterval(paintConnection, POLL_INTERVAL_MS);
    // 版本查询要跑子进程(dsh --version + pnpm view),比较慢,所以不阻塞首屏。
    loadDsh();
  }

  return {
    refresh,
    /// 离开服务端页时停表:状态点不可见就不该继续跑。
    stop() {
      refreshGeneration += 1;
      dshLoadGeneration += 1;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
