// 「添加插件」弹窗。对齐 Mac PluginsPage 的 install sheet:包名/地址 → 检查 →
// 确认安装 → 安装中可取消 → 结果就地显示。
//
// 几处判断值得写下来:
//   1. requestId 由这里生成并全程固定 —— 宿主的 cancelInstall 只认这个 id,
//      每次重试都换 id 的话,用户上一次点的取消会取消掉这一次。
//   2. 进度是流式事件(plugin-manager/install-state / install-log),与安装的
//      RPC 往返并行到达。弹窗要同时吃这两路,所以它订阅 deps.sessions 的进度
//      并按 requestId 过滤 —— 别的客户端(比如 Mac 端)的安装不该出现在这里。
//   3. 0.1.7 下载源(Mac AddPluginDialog.registryPicker):选项在检查时解析成
//      「首先问的源」;安装从检查时**作答**的那个源开始(web startInstall 用
//      inspected.registry),不从检查已经发现不通的源开始。宿主每问一个源通告一次
//      installing + attempt,这里只照实显示,不预演宿主的询问计划。
import { t } from "../../../shared/i18n.js";
import { button, textInput, select, notice, escapeHtml } from "./settings-ui.js";
import {
  REGISTRY_CHOICES, readRegistryChoice, saveRegistryChoice, resolveRegistryChoice,
  registryName, registriesText
} from "../../../features/settings/plugin-registry.js";

const MAX_LOG_LINES = 12;

const CHOICE_LABEL = {
  automatic: "plug.registryAutomatic",
  official: "plug.registryOfficial",
  mirror: "plug.registryMirror",
  custom: "plug.registryCustom"
};

/// 宿主阶段 → 弹窗阶段。installing 是"正在跑 pnpm"(Mac 把它记成 running)。
const HOST_PHASE = { installing: "running", cancelling: "cancelling", applying: "applying" };

export function openPluginInstallSheet({ sheet, settingsDialog, deps, settingsService, showToast, onInstalled }) {
  // 一次安装一个 requestId;整个弹窗生命周期内不变。
  const requestId = `dsh-ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let inspectResult = null;
  let spec = "";
  let phase = "idle";
  let error = null;
  const logLines = [];
  let token = null;
  // 下载源:上次的选择 + 自定义地址(记在本浏览器)。
  const registry = { ...readRegistryChoice(), invalid: false };
  // 这次安装首先问的源:检查时定下;undefined = 省略,由宿主按配置问。
  let installRegistry;
  // 宿主通告过的尝试(按顺序)与它可能问的总数;失败时的归因。
  let attempts = [];
  let attemptTotal = 0;
  let failure = null;

  const unsubscribe = deps.sessions?.onPluginInstallProgress?.((channel, payload) => {
    if (!payload || payload.requestId !== requestId) return;
    if (channel === "state") {
      // 已经在取消时,晚到的 installing 不把按钮拨回"取消安装"(Mac installProgress)。
      if (!(phase === "cancelling" && payload.phase === "installing")) {
        phase = HOST_PHASE[payload.phase] ?? payload.phase ?? phase;
      }
      if (payload.attempt) {
        attempts.push(payload.attempt.registry ?? null);
        attemptTotal = payload.attempt.total ?? attemptTotal;
      }
      paint();
    } else if (channel === "log") {
      // 0.1.7 的日志块是 PluginInstallLogChunk{requestId, jobId, argv, text};chunk 是旧形状。
      const text = typeof payload.text === "string"
        ? payload.text
        : typeof payload.chunk === "string"
          ? payload.chunk
          : (payload.chunk?.text ?? payload.chunk?.data ?? "");
      if (text) {
        logLines.push(String(text));
        while (logLines.length > MAX_LOG_LINES) logLines.shift();
        paint();
      }
    }
  });

  function busy() {
    return phase === "inspecting" || phase === "running" || phase === "cancelling"
      || phase === "applying" || phase === "done";
  }

  function registryPicker() {
    const disabled = busy();
    const picker = `<div class="set-sheet-field"><label class="set-sheet-label" for="plug-add-registry">`
      + `${escapeHtml(t("plug.registryLabel"))}</label>`
      + select({
        id: "plug-add-registry",
        disabled,
        options: REGISTRY_CHOICES.map((value) => ({
          value, label: t(CHOICE_LABEL[value]), selected: registry.choice === value
        }))
      })
      + `</div>`;
    if (registry.choice === "automatic") {
      return picker + `<div class="set-row-hint">${escapeHtml(t("plug.registryAutomaticHint"))}</div>`;
    }
    if (registry.choice !== "custom") return picker;
    return picker
      + textInput({
        id: "plug-add-registry-url", value: registry.custom,
        placeholder: t("plug.registryCustomPlaceholder"), mono: true, disabled
      })
      + (registry.invalid ? notice(t("plug.registryInvalid")) : "");
  }

  function triedLine(registries) {
    const text = registriesText(registries);
    return text ? `<div class="set-row-hint" id="plug-install-tried">${escapeHtml(text)}</div>` : "";
  }

  function progressLines() {
    let html = "";
    if (phase === "running" && attempts.length) {
      html += `<div class="set-row-hint" id="plug-install-attempt">${escapeHtml(t("plug.registryAttempt", {
        registry: registryName(attempts[attempts.length - 1]),
        index: attempts.length,
        total: Math.max(attemptTotal, attempts.length)
      }))}</div>`;
    }
    if (phase === "failed" && failure) {
      if (failure.failedAt === "registry") html += notice(t("plug.registryFailedRegistry"), "muted");
      else if (failure.failedAt === "spec-host") html += notice(t("plug.registryFailedSpecHost"), "muted");
      html += triedLine(failure.registries);
    }
    return html;
  }

  function body() {
    const intro = `<p class="set-sheet-text">${escapeHtml(t("plug.addIntro"))}</p>`;
    const field = `<div class="set-sheet-field"><label class="set-sheet-label" for="plug-add-spec">`
      + `${escapeHtml(t("plug.addSpecLabel"))}</label>`
      + textInput({
        id: "plug-add-spec", value: spec,
        placeholder: t("plug.addSpecPlaceholder"),
        mono: true,
        disabled: busy()
      })
      + `</div>`;
    const head = intro + field + registryPicker();
    if (phase === "inspecting") return head + notice(t("plug.inspecting"), "muted");
    if (inspectResult?.status === "refused") {
      return head + notice(`${t("plug.inspectRefused")} ${inspectResult.reason ?? ""}`)
        + triedLine(inspectResult.registries);
    }
    if (inspectResult) {
      const version = inspectResult.version ? ` · v${inspectResult.version}` : "";
      const kind = inspectResult.bundle === false ? t("plug.inspectPluginOnly") : t("plug.inspectBundle");
      return head
        + `<div class="set-sheet-text"><strong>${escapeHtml(inspectResult.name ?? spec)}${escapeHtml(version)}</strong></div>`
        + `<div class="set-row-hint">${escapeHtml(kind)}${inspectResult.description ? " · " + escapeHtml(inspectResult.description) : ""}</div>`
        + progressLines()
        + (error ? notice(error) : "")
        + (logLines.length
          ? `<pre class="set-code set-install-log">${escapeHtml(logLines.join(""))}</pre>`
          : "");
    }
    return head + (error ? notice(error) : "");
  }

  function actions() {
    if (phase === "running" || phase === "cancelling" || phase === "applying") {
      return button({
        id: "plug-install-cancel",
        label: phase === "cancelling" ? t("plug.installCancelling") : t("plug.installCancel"),
        kind: "plain",
        // applying 时宿主已经在改 profile,取消只会得到 too-late。
        disabled: phase !== "running"
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

  /// spec 或源变了:检查结果作废(它属于上一个 spec / 上一个源)。返回是否真的作废了什么。
  function invalidateInspection() {
    if (phase !== "idle" && phase !== "failed") return false;
    const had = inspectResult !== null || phase === "failed";
    inspectResult = null;
    error = null;
    failure = null;
    phase = "idle";
    return had;
  }

  function bind(root) {
    if (!root) return;
    root.querySelector("#plug-add-spec")?.addEventListener("input", (event) => {
      spec = event.target.value;
      invalidateInspection();
      // 输入变化只更新按钮可用性,不整块重画 —— 重画会把输入框里的光标弄丢。
      const inspect = root.querySelector("#plug-install-inspect");
      if (inspect) inspect.disabled = !spec.trim();
    });
    root.querySelector("#plug-add-registry")?.addEventListener("change", (event) => {
      registry.choice = event.target.value;
      registry.invalid = false;
      saveRegistryChoice({ choice: registry.choice });
      invalidateInspection();
      // 选项决定下面是提示还是地址框,要重画;spec 在状态里,不会丢。
      paint();
    });
    root.querySelector("#plug-add-registry-url")?.addEventListener("input", (event) => {
      registry.custom = event.target.value;
      saveRegistryChoice({ custom: registry.custom });
      if (invalidateInspection() || registry.invalid) {
        // 旧的检查结果 / 地址报错要撤下,只能重画;重画后把焦点与光标还回去。
        registry.invalid = false;
        paint();
        const fresh = sheet.root?.querySelector("#plug-add-registry-url");
        if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
      }
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
    failure = null;
    registry.invalid = false;
    paint();
    try {
      const chosen = await resolveRegistryChoice(registry, settingsService);
      if (chosen.invalid) {
        registry.invalid = true;
        inspectResult = null;
        return;
      }
      inspectResult = await settingsService.inspectPlugin(spec.trim(), { registry: chosen.registry });
      // 通过的答复带作答的 registry(null = pnpm 自身);安装从那里开始。
      installRegistry = inspectResult && "registry" in inspectResult ? inspectResult.registry : chosen.registry;
    } catch (inspectError) {
      inspectResult = null;
      error = deps.formatErrorDetails(inspectError);
    } finally {
      if (phase === "inspecting") phase = "idle";
      paint();
    }
  }

  async function install() {
    phase = "running";
    error = null;
    failure = null;
    attempts = [];
    attemptTotal = 0;
    logLines.length = 0;
    paint();
    try {
      const result = await settingsService.installBundle(spec.trim(), {
        requestId, enabled: true, registry: installRegistry
      });
      if (result?.application === "failed") {
        phase = "failed";
        error = result.error?.diagnostic || t("plug.installFailed");
        // 宿主的答复列出它问过的每个源,不论每次尝试的通告是否到达。
        failure = { registries: result.registries ?? attempts, failedAt: result.failedAt };
      } else if (result?.application === "cancelled") {
        phase = "idle";
        error = t("plug.installCancelled");
      } else {
        phase = "done";
        error = null;
        await onInstalled?.(result);
      }
    } catch (installError) {
      phase = "failed";
      error = deps.formatErrorDetails(installError);
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
    } catch (cancelError) {
      phase = "running";
      error = deps.formatErrorDetails(cancelError);
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
