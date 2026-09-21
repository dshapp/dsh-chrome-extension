// 「添加插件」弹窗。对齐 Mac PluginsPage 的 install sheet:包名/地址 → 检查 →
// 确认安装 → 安装中可取消 → 结果就地显示。
//
// 两处判断值得写下来:
//   1. requestId 由这里生成并全程固定 —— 宿主的 cancelInstall 只认这个 id,
//      每次重试都换 id 的话,用户上一次点的取消会取消掉这一次。
//   2. 进度是流式事件(plugin-manager/install-state / install-log),与安装的
//      RPC 往返并行到达。弹窗要同时吃这两路,所以它订阅 deps.sessions 的进度
//      并按 requestId 过滤 —— 别的客户端(比如 Mac 端)的安装不该出现在这里。
import { t } from "../../../shared/i18n.js";
import { button, textInput, notice, escapeHtml } from "./settings-ui.js";

const MAX_LOG_LINES = 12;

export function openPluginInstallSheet({ sheet, settingsDialog, deps, settingsService, showToast, onInstalled }) {
  // 一次安装一个 requestId;整个弹窗生命周期内不变。
  const requestId = `dsh-ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let inspectResult = null;
  let spec = "";
  let phase = "idle";
  let error = null;
  const logLines = [];
  let token = null;

  const unsubscribe = deps.sessions?.onPluginInstallProgress?.((channel, payload) => {
    if (!payload || payload.requestId !== requestId) return;
    if (channel === "state") {
      phase = payload.phase ?? phase;
      paint();
    } else if (channel === "log") {
      const text = typeof payload.chunk === "string"
        ? payload.chunk
        : (payload.chunk?.text ?? payload.chunk?.data ?? "");
      if (text) {
        logLines.push(String(text));
        while (logLines.length > MAX_LOG_LINES) logLines.shift();
        paint();
      }
    }
  });

  function body() {
    const intro = `<p class="set-sheet-text">${escapeHtml(t("plug.addIntro"))}</p>`;
    const field = `<div class="set-sheet-field"><label class="set-sheet-label" for="plug-add-spec">`
      + `${escapeHtml(t("plug.addSpecLabel"))}</label>`
      + textInput({
        id: "plug-add-spec", value: spec,
        placeholder: t("plug.addSpecPlaceholder"),
        mono: true,
        disabled: phase === "running" || phase === "cancelling"
      })
      + `</div>`;
    if (phase === "inspecting") return intro + field + notice(t("plug.inspecting"), "muted");
    if (inspectResult?.status === "refused") {
      return intro + field + notice(`${t("plug.inspectRefused")} ${inspectResult.reason ?? ""}`);
    }
    if (inspectResult) {
      const version = inspectResult.version ? ` · v${inspectResult.version}` : "";
      const kind = inspectResult.bundle === false ? t("plug.inspectPluginOnly") : t("plug.inspectBundle");
      return intro + field
        + `<div class="set-sheet-text"><strong>${escapeHtml(inspectResult.name ?? spec)}${escapeHtml(version)}</strong></div>`
        + `<div class="set-row-hint">${escapeHtml(kind)}${inspectResult.description ? " · " + escapeHtml(inspectResult.description) : ""}</div>`
        + (error ? notice(error) : "")
        + (logLines.length
          ? `<pre class="set-code set-install-log">${escapeHtml(logLines.join(""))}</pre>`
          : "");
    }
    return intro + field + (error ? notice(error) : "");
  }

  function actions() {
    if (phase === "running" || phase === "cancelling") {
      return button({
        id: "plug-install-cancel",
        label: phase === "cancelling" ? t("plug.installCancelling") : t("plug.installCancel"),
        kind: "plain",
        disabled: phase === "cancelling"
      });
    }
    if (phase === "done") {
      return button({ id: "plug-install-close", label: t("set.done"), kind: "primary" });
    }
    if (inspectResult?.status === "accepted") {
      return button({ id: "plug-install-close", label: t("set.cancel") })
        + button({ id: "plug-install-run", label: t("plug.install"), kind: "primary" });
    }
    return button({ id: "plug-install-close", label: t("set.cancel") })
      + button({
        id: "plug-install-inspect",
        label: t("plug.inspect"),
        kind: "primary",
        disabled: !spec.trim()
      });
  }

  function paint() {
    if (token === null) return;
    sheet.setBody(body(), token);
    sheet.setActions(actions(), token);
    bind(sheet.root);
  }

  function bind(root) {
    if (!root) return;
    root.querySelector("#plug-add-spec")?.addEventListener("input", (event) => {
      spec = event.target.value;
      inspectResult = null;
      error = null;
      // 输入变化只更新按钮可用性,不整块重画 —— 重画会把输入框里的光标弄丢。
      const inspect = root.querySelector("#plug-install-inspect");
      if (inspect) inspect.disabled = !spec.trim();
    });
    root.querySelector("#plug-install-close")?.addEventListener("click", () => {
      unsubscribe?.();
      sheet.close(token);
    });
    root.querySelector("#plug-install-inspect")?.addEventListener("click", inspect);
    root.querySelector("#plug-install-run")?.addEventListener("click", install);
    root.querySelector("#plug-install-cancel")?.addEventListener("click", cancel);
  }

  async function inspect() {
    phase = "inspecting";
    error = null;
    paint();
    try {
      inspectResult = await settingsService.inspectPlugin(spec.trim());
    } catch (failure) {
      inspectResult = null;
      error = deps.formatErrorDetails(failure);
    } finally {
      if (phase === "inspecting") phase = "idle";
      paint();
    }
  }

  async function install() {
    phase = "running";
    error = null;
    logLines.length = 0;
    paint();
    try {
      const result = await settingsService.installBundle(spec.trim(), { requestId, enabled: true });
      if (result?.application === "failed") {
        phase = "failed";
        error = result.error?.diagnostic || t("plug.installFailed");
      } else if (result?.application === "cancelled") {
        phase = "idle";
        error = t("plug.installCancelled");
      } else {
        phase = "done";
        error = null;
        await onInstalled?.(result);
      }
    } catch (failure) {
      phase = "failed";
      error = deps.formatErrorDetails(failure);
      showToast?.(error);
    } finally {
      paint();
    }
  }

  async function cancel() {
    phase = "cancelling";
    paint();
    try {
      const result = await settingsService.cancelInstall(requestId);
      // too-late 表示 pnpm 已经在改 profile 了:如实说明,不要假装取消成功。
      if (result?.status === "too-late") {
        phase = "running";
        error = t("plug.installTooLate");
      } else if (result?.status === "not-running") {
        phase = "idle";
      }
    } catch (failure) {
      phase = "running";
      error = deps.formatErrorDetails(failure);
    } finally {
      paint();
    }
  }

  token = sheet.open({
    title: t("plug.addTitle"),
    body: body(),
    actions: actions(),
    bind: (root) => bind(root)
  });
  sheet.root?.querySelector("#plug-add-spec")?.focus();
  // 关闭时一定要退订,否则下一次安装的进度还会往这块已经关掉的 dialog 上打。
  // sheet.close() 会清空 body,所以监听挂在整个 dialog 上而不是内容节点上。
  settingsDialog?.addEventListener("close", () => unsubscribe?.(), { once: true });
  return token;
}
