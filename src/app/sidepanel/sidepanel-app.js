// 侧栏应用主体:DOM 编排 + 帧分发。
// 与旧版的关键差别:渲染输入是 store 派生的 nodes[],交互卡通过 takeover 接管输入框,
// plan chip / 触发菜单 / 权限二次确认按 Mac 的座位语义接线。
import { t } from "../../shared/i18n.js";
import { createChatRenderer, agentStatusLabel, isThinking } from "../../features/chat/index.js";
import {
  createApprovalCard, createQuestionCard, tryCreatePlanReviewCard, resolveTakeover
} from "../../features/interactions/index.js";
import { createQueuePanel } from "../../features/prompt-queue/index.js";
import { mountHistoryDrawer } from "./sidepanel-overlays.js";
import { mountSettings } from "./settings/settings-root.js";
import { mountWorkspaceMenu } from "./workspace-menu.js";
import { createComposerMenus } from "./composer-menus.js";
import { createComposerDock } from "./composer-dock.js";
import { mountTriggerMenu } from "./trigger-menu.js";
import { projectDraft, reconcileEdit, renderChipMirror, PLACEHOLDER } from "./composer-chips.js";
import { collectElements } from "./sidepanel-elements.js";
import { mountAttachmentControls } from "./composer-attachments.js";
import { createSessionShortcutController, getSessionShortcutLabels } from "../../features/sessions/session-shortcuts.js";
import { mountGoalBar, mountTodoPanel, mountStatsBar } from "../../features/docks/session-docks.js";
import { mountSubagentCatalog } from "../../features/subagents/subagent-catalog-view.js";
import { createElementPicker } from "../../features/element-picker/element-picker.js";
import { isElementPickerToggleChord, elementPickerShortcutLabel } from "../../features/element-picker/element-picker-shortcut.js";
import { resolveSubmitMode, isSteerChord, DEFAULT_BUSY_ENTER } from "../../features/prompt-queue/index.js";

export function createSidepanelApp(root, deps) {
  const elements = collectElements(root);
  let sending = false;
  let historyDrawer = null;
  let workspaceMenu = null;
  // 每会话草稿:切走时保存未发送文本,切回时恢复。
  const drafts = new Map();
  /// 草稿的唯一写入口 —— 顺带把「有没有未发送文字」同步给列表 store,
  /// 侧栏行才能像 macOS 那样在未打开的会话上打出「草稿」徽章。
  /// 空白/纯空格不算草稿,否则敲一个空格就会让行上多出一个徽章。
  function setDraft(sessionId, text) {
    if (!sessionId) return;
    const value = text ?? "";
    const meaningful = Boolean(value.trim());
    if (meaningful) drafts.set(sessionId, value);
    else drafts.delete(sessionId);
    // 可选调用:列表 store 是数据源里的一块,不是草稿功能的前提 ——
    // 它缺席(或还没接上)时草稿本身照常工作,只是行上不亮徽章。
    deps.sessions.listStore?.setDraft?.(sessionId, meaningful);
  }

  const chatRenderer = createChatRenderer(elements.msgList, {
    onFork: handleFork,
    getContext: () => ({ cwd: state.cwd, home: state.hostHome })
  });

  // 乐观等待位:sendMessage 提交后到 server 回出 turn/start 之间有网络/模型启动延迟,
  // 这段空窗期 snapshot.running 仍为 false,手动补上"准备中"。
  let awaitingTurnStart = false;

  const state = {
    sessionId: null,
    streamState: deps.DshStreamState.DISCONNECTED,
    running: false,
    permissions: null,
    currentModel: null,
    models: [],
    cwd: null,
    hostHome: null,
    // 宿主自身的工作目录(host.describe 的 cwd)。未选工作目录创建的会话都落在
    // 这里,所以它同时是历史过滤「临时目录」这一项的路径。
    hostCwd: null,
    // 子代理会话:队列与当前轮都不归本端管,插队不可用。
    subagent: null
  };

  // ---- 帧分发 ----
  deps.onFrame((frame, stream) => {
    if (stream === "mux") deps.sessions.handleMuxFrame(frame);
    else deps.sessions.handleHostFrame(frame);
  });

  // ---- 渲染 ----
  // 流式帧按 animation frame 合并:一个帧周期内的多次 onRuntimeChange 只渲染一次,
  // 避免高帧率流式(每 token 一帧)下每个事件都同步重建 DOM。
  let renderScheduled = false;
  let pendingSnapshot = null;

  deps.sessions.onRuntimeChange((snapshot) => {
    if (snapshot.sessionId !== state.sessionId) return;
    pendingSnapshot = snapshot;
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      const snap = pendingSnapshot;
      pendingSnapshot = null;
      if (!snap || snap.sessionId !== state.sessionId) return;
      applySnapshot(snap);
    });
  });

  function applySnapshot(snapshot) {
    if (snapshot.running) awaitingTurnStart = false;
    state.cwd = snapshot.cwd ?? state.cwd;
    state.subagent = snapshot.subagent ?? null;

    chatRenderer.render(snapshot.nodes);
    const statusLabel = agentStatusLabel(snapshot, { awaitingTurnStart });
    chatRenderer.setTyping(statusLabel != null, statusLabel);
    chatRenderer.setThinking(isThinking(snapshot));
    elements.emptyHint.hidden = snapshot.nodes.length > 0;

    renderTakeover(snapshot);
    renderQueuePanel(snapshot.queue, snapshot);
    goalBar.set(snapshot.goal);
    todoPanel.set(snapshot.todos);
    // 当前模式名由 dock 从 roster 解析(出厂预设走本地化文案,如 code → PTC 模式),
    // 显示在统计浮层顶部。
    statsBar.set({ ...snapshot, presetName: dock.currentPresetName() });
    subagentCatalog.refresh();
    // 图片限制以宿主投影为准,composer 据此在本地就把超限文件挡下。
    deps.attachments.setLimits?.(snapshot.imageLimits);
    dock.renderPlanChip(snapshot.planMode);
    // 占位符与可用性统一在这里裁决(子代理只读 > 计划模式 > 默认)。
    applyComposerAvailability(snapshot);
    if (snapshot.permissions) dock.renderPermMenu(snapshot.permissions);
    autoScroll();
    historyDrawer?.setActive(state.sessionId, snapshot.title);
    updateSendState(snapshot.running);
  }

  // ---- 交互接管 ----
  // 卡片挂在 composer 上方并隐藏输入框(对齐 Mac 的 ComposerTakeover)。
  // 引用未变时不重建 DOM,否则会打断正在编辑的输入、丢焦点,并泄漏 document 级键盘监听。
  let renderedTakeoverKey = null;
  let takeoverCard = null;

  function takeoverKey(takeover) {
    if (!takeover) return null;
    if (takeover.kind === "approval") return `approval:${takeover.approval.approvalId}`;
    const q = takeover.question;
    return `question:${q.rpcId ?? (q.questions ?? []).map((i) => i.id).join(":")}`;
  }

  function renderTakeover(snapshot) {
    const takeover = resolveTakeover({
      question: snapshot.pendingQuestion,
      approval: snapshot.pendingApproval
    });
    const key = takeoverKey(takeover);
    if (key === renderedTakeoverKey) return;

    takeoverCard?.dispose?.();
    takeoverCard?.remove();
    takeoverCard = null;
    renderedTakeoverKey = key;

    if (!takeover) {
      elements.composerTakeover.hidden = true;
      elements.composer.hidden = false;
      elements.input.focus();
      return;
    }

    const onRespond = (rpcId, result) => deps.connection.respond(rpcId, result);
    if (takeover.kind === "approval") {
      takeoverCard = createApprovalCard(takeover.approval, { onRespond, store: deps.sessions.store });
    } else {
      // 计划审阅有专用卡;不是计划审阅才落到通用问答向导。
      takeoverCard = tryCreatePlanReviewCard(takeover.question, { onRespond })
        ?? createQuestionCard(takeover.question, { onRespond });
    }
    elements.composerTakeover.replaceChildren(takeoverCard);
    elements.composerTakeover.hidden = false;
    // 输入框让位给卡片:交互挂起期间打字没有去处,留着只会让人误以为可以发消息。
    elements.composer.hidden = true;
  }

  /// 输入框占位符只在这一处决定,避免多个渲染分支互相覆盖。
  /// 优先级:子代理只读 > 计划模式 > 默认。
  function applyComposerAvailability(snapshot) {
    const readOnly = Boolean(snapshot.subagent && snapshot.subagent.readOnly);
    elements.input.disabled = readOnly;
    elements.input.placeholder = readOnly
      ? t("subagent.readOnly")
      : snapshot.planMode === true
        ? t("composer.placeholderPlan")
        : t("input.placeholder");
    if (readOnly) elements.send.disabled = true;
  }

  /// 队列面板每次快照都重建:面板自身只持有编辑/请求中的瞬时状态,
  /// 队列内容的唯一权威是宿主推送的 session/queue 帧。
  function renderQueuePanel(queue, snapshot) {
    const previous = elements.promptQueue.firstElementChild;
    const panel = createQueuePanel(queue, {
      onAction: handleQueueAction,
      // 插队要有"当前轮"可插;子代理会话的队列不归本端管,只读展示。
      running: Boolean(snapshot?.running),
      mutable: !snapshot?.subagent
    });
    if (previous) previous.replaceWith(panel); else elements.promptQueue.appendChild(panel);
    elements.promptQueue.hidden = panel.hidden;
  }

  async function handleQueueAction(itemId, action) {
    if (!state.sessionId) return;
    const payload = typeof action === "object"
      ? { kind: "edit", content: [{ type: "text", text: action.text }] }
      : action === "steer" ? { kind: "steer" } : { kind: "remove" };
    try {
      await deps.sessions.updateQueue(state.sessionId, itemId, payload);
    } catch (error) {
      // 插队/删除撞上 agent 刚好取走该条:队列帧已经反映了结果,不是用户能处理的失败。
      const code = error?.code;
      if (code === "steer-unavailable" || code === "queue-item-not-found") return;
      showToast(format(error));
    }
  }

  // ---- 连接状态 ----
  function setStreamState(next) {
    state.streamState = next;
    const dot = elements.hdrStatus;
    dot.className = next === deps.DshStreamState.CONNECTED ? "ok"
      : next === deps.DshStreamState.CONNECTING ? "busy" : "err";
    // 断开时可点击:状态点变成手动重连入口。
    const clickable = next !== deps.DshStreamState.CONNECTED;
    dot.style.cursor = clickable ? "pointer" : "";
    dot.setAttribute("role", clickable ? "button" : "");
    dot.title = next === deps.DshStreamState.CONNECTED ? t("status.connected", { host: hostLabel() })
      : next === deps.DshStreamState.CONNECTING ? t("status.connecting")
      : t("status.disconnected") + " · " + t("srv.reconnect");
    updateSendState();
  }

  function hostLabel() {
    try { return new URL(deps.connection.baseUrl).host; }
    catch { return deps.connection.baseUrl || "?"; }
  }

  // ---- 发送/停止/排队 ----
  function updateSendState(running) {
    if (running !== undefined) state.running = running;
    const hasInput = elements.input.value.trim().length > 0
      || deps.attachments.pending.length > 0
      || picker.picked.length > 0;
    const connected = state.streamState === deps.DshStreamState.CONNECTED;
    if (state.running) {
      if (hasInput) {
        elements.send.className = "state-queue";
        elements.send.textContent = "＋";
        elements.send.title = t("queue.send");
      } else {
        elements.send.className = "state-stop";
        elements.send.textContent = "■";
        elements.send.title = t("stop");
      }
      elements.send.disabled = false;
    } else {
      elements.send.className = "state-idle";
      elements.send.textContent = "↑";
      elements.send.title = t("send");
      elements.send.disabled = !connected || !hasInput;
    }
  }

  // 忙时普通 Enter 的投递偏好。宿主设置里可改;这里缓存一份供发送路径同步取用,
  // 免得每次按 Enter 都去 await 一次 settings.describe()。
  let busyEnter = DEFAULT_BUSY_ENTER;

  /// 设置页改了偏好后调用,让快捷键语义立刻跟上,不用等重开侧栏。
  function setBusyEnter(behavior) {
    busyEnter = behavior === "steer" ? "steer" : "queue";
  }

  /// 启动时读一次宿主里存的偏好。读不到(旧宿主没有这个命名空间)就留默认值 ——
  /// 插队快捷键不依赖它可用,只是决定普通 Enter 的那一面。
  async function loadBusyEnter() {
    try {
      const described = await deps.connection.call("settings.describe", {});
      for (const namespace of described?.namespaces ?? []) {
        if (namespace?.ns !== "ui-conversation") continue;
        const value = namespace.value;
        if (value && typeof value === "object" && value.busyEnter) setBusyEnter(value.busyEnter);
      }
    } catch {
      // 忽略:偏好读不到就用默认 queue。
    }
  }

  async function sendMessage({ gesture = "enter" } = {}) {
    // 发送的是展开后的文本:占位符换回 "@完整路径"(对齐 Mac project())。
    // draft 保留原始带占位符的文本,发送失败时用它连同胶囊一起回填。
    const draft = elements.input.value;
    const text = projectDraft(draft, occurrences).trim();
    const attachments = deps.attachments.pending;
    const pickedElements = picker.picked;
    // 只选了元素、一个字没打也算有内容:元素本身就是这一轮的指代对象。
    if (!state.sessionId || sending) return;
    // 插队手势不该被"停止"按钮态吃掉:agent 正跑时发送键显示为停止,
    // 但 ⌥⌘↩ 的语义是插队发送,不是中断。
    // 这一条必须排在"没有内容就返回"之前:停止态恰恰是输入框为空时才出现的
    // (有内容时按钮是 state-queue),先判空会让停止按钮永远点不动。
    if (elements.send.className === "state-stop" && gesture !== "modifier") return stopRun();
    if (!text && !attachments.length && !pickedElements.length) return;
    // 子代理会话的队列不归本端管,没有可插的当前轮。
    const steeringAvailable = !state.subagent;
    const mode = resolveSubmitMode(state.running, gesture, steeringAvailable, busyEnter);
    if (!attachments.length && await menus.tryDispatchCommand(text)) {
      setInputText("");
      autoResizeInput();
      updateSendState();
      return;
    }
    sending = true;
    const sentOccurrences = occurrences;
    setInputText("");
    setDraft(state.sessionId, "");
    autoResizeInput();
    updateSendState();
    awaitingTurnStart = true;
    chatRenderer.setTyping(true, t("statusPreparing"));
    try {
      const content = [];
      // 选取的元素以语义化 XML 拼在最前面,后接 [指令] 分隔用户原话,
      // 让模型能稳定解析出"用户指代了哪些元素"以及各自的定位符。
      const pickedContext = pickedElements.length ? picker.context(pickedElements) : "";
      const promptText = pickedContext
        ? `${pickedContext}\n\n[指令] ${text || t("picker.instruction")}`
        : text;
      if (promptText) content.push({ type: "text", text: promptText });
      for (const attachment of attachments) content.push(attachment.part);
      // mode 决定这条消息是进队列还是插入当前轮。插队发的就是输入框这一条,
      // 队列保持原样 —— 与 session/queue 的 steer(把队列条目提前)是两件事。
      await deps.sessions.prompt(state.sessionId, content, { mode });
      // 发送成功后才清空附件与元素:失败时它们原样保留,用户可直接重试。
      deps.attachments.clear();
      attachmentControls.render();
      // 元素随消息一并消费:发出去之后这一轮的指代就结束了。
      picker.clear();
    } catch (error) {
      awaitingTurnStart = false;
      chatRenderer.setTyping(false);
      showToast(format(error));
      // 回填的是原始草稿(带占位符)+ 原胶囊,不是展开后的文本,
      // 否则失败一次胶囊就退化成裸路径。
      setInputText(draft, sentOccurrences);
    } finally {
      sending = false;
      elements.input.focus();
    }
  }

  async function stopRun() {
    if (!state.sessionId) return;
    try { await deps.sessions.cancel(state.sessionId); }
    catch (error) { showToast(format(error)); }
  }

  async function handleFork(node) {
    // 分叉点:turnTail 用它自己的 seq(turn/end 的边界,服务端接受);
    // 其他节点沿用 forkSeq。assistant step 的 seq 落在未闭合轮次内,会被 OPEN_TURN 拒绝。
    const at = Number.isInteger(node?.forkSeq) ? node.forkSeq
      : (node?.kind === "turnTail" && Number.isInteger(node.seq) ? node.seq : null);
    if (!state.sessionId || at == null) return;
    try {
      const childId = await deps.sessions.fork(state.sessionId, at);
      await openSession(childId);
    } catch (error) {
      showToast(format(error));
    }
  }

  // ---- 会话停靠区 ----
  const goalBar = mountGoalBar(elements.goalBarSlot, {
    onPause: () => deps.goals.pause(state.sessionId, currentGoal()),
    onResume: () => deps.goals.resume(state.sessionId, currentGoal()),
    onEdit: (objective) => deps.goals.edit(state.sessionId, currentGoal(), objective),
    onClear: () => deps.goals.clear(state.sessionId, currentGoal())
  });
  const todoPanel = mountTodoPanel(elements.todoPanel);
  const statsBar = mountStatsBar(elements.statsBtn, elements.statsMenu, {
    // 上下文吃紧时把"压缩"放在手边,省得用户去翻斜杠命令。
    onCompact: async () => {
      if (!state.sessionId) return;
      try { await deps.commands.execute(state.sessionId, "/compact"); }
      catch (error) { showToast(format(error)); }
    }
  });
  function currentGoal() {
    return deps.sessions.getRuntimeSnapshot().goal;
  }

  // 子代理目录入口(header chip + 树形 popover,对齐 Mac SubagentCatalogAction)。
  const subagentCatalog = mountSubagentCatalog(elements.subagentCatalogBtn, elements.subagentCatalogMenu, {
    deps,
    getSessionId: () => state.sessionId,
    onOpenSubagent: (address) => { void openSubagent(address); }
  });

  // ---- 页面元素选取 ----
  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
  const picker = createElementPicker({
    showToast, t,
    onChange: () => { renderPickerButton(); renderPickedChip(); updateSendState(); }
  });

  function renderPickerButton() {
    const button = elements.elementPickerBtn;
    const on = picker.active;
    button.classList.toggle("state-on", on);
    button.classList.toggle("state-off", !on);
    button.setAttribute("aria-pressed", String(on));
    button.title = `${t("picker.pick")} (${elementPickerShortcutLabel(isMac)})`;
  }

  function renderPickedChip() {
    const list = picker.picked;
    elements.pickedChip.hidden = list.length === 0;
    if (!list.length) {
      elements.pickedMenu.replaceChildren();
      elements.pickedMenu.hidePopover?.();
      void picker.clearHighlight();
      return;
    }
    elements.pickedLabel.textContent = t("picker.label", { n: String(list.length) });
    elements.pickedMenu.replaceChildren();
    list.forEach((element, index) => {
      const row = document.createElement("div");
      row.className = "picked-element-row";
      const text = document.createElement("span");
      text.className = "picked-element-text";
      text.textContent = element.name || element.selector || element.tag || "element";
      text.title = element.xpath || element.selector || "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "picked-element-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", t("picker.remove"));
      remove.addEventListener("click", () => picker.remove(index));
      // hover 联动页面高亮,让用户确认"这一条对应的是哪个元素"。
      row.addEventListener("mouseenter", () => void picker.highlight(element));
      row.addEventListener("mouseleave", () => void picker.clearHighlight());
      row.append(text, remove);
      elements.pickedMenu.append(row);
    });
  }

  const menus = createComposerMenus({ elements, deps, state, showToast, format });
  const dock = createComposerDock({ elements, deps, state, showToast, format });
  const { refreshSlashSources } = menus;

  // 引用胶囊:草稿里存 U+FFFC 占位符,真正的引用文本存在这里(对齐 Mac ComposerState.occurrences)。
  let occurrences = [];
  let lastDraft = elements.input.value;

  /// 草稿每次变化都要重算胶囊位置并重画镜像层。
  function syncChips() {
    const draft = elements.input.value;
    // 无占位符快速路径:没有胶囊,reconcile 的全文 diff 与占位符扫描都省掉,
    // 只让镜像层保持行高(长草稿打字的主要热点之一)。
    if (occurrences.length === 0 && draft.indexOf(PLACEHOLDER) === -1) {
      lastDraft = draft;
      renderChipMirror(elements.inputMirror, draft, occurrences);
      elements.inputMirror.scrollTop = elements.input.scrollTop;
      return;
    }
    occurrences = reconcileEdit(lastDraft, draft, occurrences);
    lastDraft = draft;
    renderChipMirror(elements.inputMirror, draft, occurrences);
    // 镜像层不滚动,靠跟随 textarea 的滚动位置保持对齐。
    elements.inputMirror.scrollTop = elements.input.scrollTop;
  }

  /// 直接改写输入框内容(清空/恢复草稿/发送失败回填)的唯一入口。
  /// 绕过它就会留下"文字没了但胶囊还在"的残影 —— 胶囊状态必须跟着一起重置。
  function setInputText(value, nextOccurrences = []) {
    elements.input.value = value;
    occurrences = nextOccurrences;
    lastDraft = value;
    renderChipMirror(elements.inputMirror, value, occurrences);
  }

  const triggerMenu = mountTriggerMenu({
    elements, deps, state,
    getOccurrences: () => occurrences,
    // 候选被选中时由菜单回调插入胶囊,菜单自己不再拼裸文本。
    onInsertReference: (next) => {
      occurrences = next.occurrences;
      lastDraft = next.text;
      renderChipMirror(elements.inputMirror, next.text, occurrences);
    }
  });

  // ---- 元素选取事件 ----
  elements.elementPickerBtn.addEventListener("click", () => void picker.toggle());
  elements.pickedClear.addEventListener("click", () => picker.clear());
  // 菜单收起时撤掉页面上的 hover 高亮,不留残影。
  elements.pickedMenu.addEventListener("toggle", (event) => {
    if (event.newState === "closed") void picker.clearHighlight();
  });
  // ⌘. / Ctrl+. 与按钮共用 toggle,保证两条路径状态一致。
  document.addEventListener("keydown", (event) => {
    if (!isElementPickerToggleChord(event, { mac: isMac })) return;
    event.preventDefault();
    event.stopPropagation();
    void picker.toggle();
  }, true);
  picker.attach();

  const attachmentControls = mountAttachmentControls({
    elements, deps, showToast, onChange: () => updateSendState()
  });

  // ---- 输入区 ----
  elements.input.addEventListener("input", () => {
    autoResizeInput();
    syncChips();
    updateSendState();
    setDraft(state.sessionId, elements.input.value);
    triggerMenu.handleInput();
  });
  elements.input.addEventListener("scroll", () => {
    elements.inputMirror.scrollTop = elements.input.scrollTop;
  });
  // 插入胶囊后菜单派发 change(而非 input):此时占位符与 occurrences 已同步好,
  // 这里只补做「输入变化」的其余副作用。
  elements.input.addEventListener("change", () => {
    autoResizeInput();
    updateSendState();
    setDraft(state.sessionId, elements.input.value);
  });
  elements.input.addEventListener("keydown", (event) => {
    // 触发菜单开启时优先吃掉导航键。
    if (triggerMenu.handleKeyDown(event)) return;
    // IME 组合输入确认候选时也会派发 Enter:那是选字不是发送,
    // 也不该被当成插队快捷键(⌥⌘↩)。
    if (event.isComposing) return;
    // 插队快捷键(⌥⌘↩)必须在普通 Enter 之前判:它也带 Enter,
    // 落到下面那条分支就会被当成普通发送而进队列。
    if (isSteerChord(event, { mac: isMac })) {
      event.preventDefault();
      sendMessage({ gesture: "modifier" });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage({ gesture: "enter" });
    }
  });
  elements.send.addEventListener("click", () => sendMessage({ gesture: "enter" }));

  function autoResizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 160)}px`;
  }

  function autoScroll() {
    const scroller = elements.messages;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  // toast 的隐藏是延时的:重复调用必须先撤掉上一次的定时器,否则旧 timer
  // 会把新 toast 提前关掉。
  let toastTimer = null;
  let toastLeaveTimer = null;

  /// 顶部 toast(antd message 风格)。type: error | success | info。
  function showToast(message, type = "error") {
    clearTimeout(toastTimer);
    clearTimeout(toastLeaveTimer);

    const icons = { error: "!", success: "✓", info: "i" };
    const kind = icons[type] ? type : "error";
    const host = elements.toast;
    host.textContent = "";

    const card = document.createElement("div");
    card.className = "toast-card " + kind;
    card.setAttribute("role", kind === "error" ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = icons[kind];

    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;

    card.append(icon, text);
    host.append(card);
    host.hidden = false;

    toastTimer = setTimeout(() => {
      card.classList.add("leaving");
      // 等退场动画播完再隐藏,否则卡片会瞬间消失。
      toastLeaveTimer = setTimeout(() => { host.hidden = true; host.textContent = ""; }, 300);
    }, 4000);
  }

  function format(error) {
    // 附件校验错误自带 i18n key,按当前语言渲染而不是把 key 原样吐给用户。
    if (error?.i18nKey) return t(error.i18nKey, error.i18nParams ?? {});
    return deps.formatErrorDetails(error);
  }

  // ---- 会话切换 ----
  /// 新建会话。
  ///
  /// workspaceId 与 cwd 在 session.create 上是**互斥**的:两者同时给会被宿主判
  /// bad-request 整体拒绝(已在真实后端验证),表现就是"点新建没任何反应"。
  /// Mac 端也是两个独立入口(createSession(cwd:) / createSession(in:)),从不同时传。
  /// 这里选 workspaceId —— 它是宿主认的归属标识,cwd 只是它的显示路径。
  ///
  /// 注意 options 必须防御非对象:这个函数直接当过 click 监听器,
  /// 那时传进来的是 MouseEvent。
  async function newSession(options) {
    const { _retried = false } = (options && typeof options === "object" && !("target" in options))
      ? options : {};
    const workspace = workspaceMenu?.selected() ?? null;
    const input = workspace?.workspaceId
      ? { workspaceId: workspace.workspaceId }
      : workspace?.path
        ? { cwd: workspace.path }
        : {};
    const sessionId = await deps.sessions.create(input);
    await openSession(sessionId, { fresh: true, _retried });
  }

  function isSessionUnopenable(error) {
    return ["agent-busy", "session-not-found", "internal"].includes(error?.code);
  }

  // 会话打开竞态令牌:快速切换时迟到的历史加载不得覆盖新会话。
  let openSessionToken = 0;

  async function openSession(sessionId, { fresh = false, _retried = false } = {}) {
    const token = ++openSessionToken;
    // 离开当前会话前存草稿。
    setDraft(state.sessionId, elements.input.value);

    state.sessionId = sessionId;
    awaitingTurnStart = false;
    chatRenderer.reset();
    // 切会话必须拆掉旧交互卡:它的 document 级键盘监听会一直活着。
    takeoverCard?.dispose?.();
    takeoverCard?.remove();
    takeoverCard = null;
    renderedTakeoverKey = null;
    elements.composerTakeover.replaceChildren();
    elements.composerTakeover.hidden = true;
    elements.composer.hidden = false;
    elements.emptyHint.hidden = false;
    historyDrawer?.setActive(sessionId, null);
    subagentCatalog.refresh();

    try {
      if (fresh) await deps.sessions.open(sessionId);
      else await deps.sessions.loadHistory(sessionId);
    } catch (error) {
      if (!_retried && isSessionUnopenable(error)) {
        showToast(format(error));
        await newSession({ _retried: true });
        return;
      }
      showToast(format(error));
    }

    // 等待期间用户又切走了:迟到结果不得渲染到新会话上。
    if (token !== openSessionToken) return;

    // 会话切换是一次性操作,直接同步渲染,不等 onRuntimeChange 的 rAF 合并:
    // rAF 在侧栏不可见(visibilityState=hidden)时不会触发,renderScheduled 一旦卡在
    // true,后续 notifyRuntime 全被「if (renderScheduled) return」吞掉,聊天记录永远不渲染。
    // applySnapshot 内含 chatRenderer.render + emptyHint + setActive 等完整刷新。
    applySnapshot(deps.sessions.getRuntimeSnapshot());

    const summary = deps.sessions.listStore.get().find((item) => item.sessionId === sessionId);
    if (summary?.cwd) {
      state.cwd = summary.cwd;
      workspaceMenu?.setActiveByCwd(summary.cwd);
    }
    // 切会话:上一轮选的元素属于上一个语境,不该跟着带过来。
    picker.clear();
    renderPickedChip();
    // 恢复该会话的草稿。
    // 切会话:草稿是纯文本(胶囊不跨会话保留),占位符一并清掉。
    setInputText((drafts.get(sessionId) ?? "").split("\uFFFC").join(""));
    autoResizeInput();
    updateSendState();

    dock.refreshModelMenu();
    // roster 是异步拉的,会落在本次渲染之后 —— 拿到后补画一次统计浮层,
    // 否则当前模式名要等下一帧才出现。
    dock.refreshPresetMenu().then(() => {
      statsBar.set({ ...deps.sessions.getRuntimeSnapshot(), presetName: dock.currentPresetName() });
    });
    refreshSlashSources();
  }

  /// 打开一个子代理会话(只读)。对齐 Mac selectSubagent:走 subagent.history 读转录
  /// 而非 session.history;composer 只读由返回的 subagent 投影驱动(applySnapshot)。
  async function openSubagent(address) {
    const childId = address?.childSessionId;
    if (!childId) return;
    const token = ++openSessionToken;
    setDraft(state.sessionId, elements.input.value);

    state.sessionId = childId;
    awaitingTurnStart = false;
    chatRenderer.reset();
    takeoverCard?.dispose?.();
    takeoverCard?.remove();
    takeoverCard = null;
    renderedTakeoverKey = null;
    elements.composerTakeover.replaceChildren();
    elements.composerTakeover.hidden = true;
    elements.composer.hidden = false;
    elements.emptyHint.hidden = false;
    historyDrawer?.setActive(childId, null);
    subagentCatalog.refresh();

    try {
      await deps.sessions.loadSubagentHistory(address);
    } catch (error) {
      // 打开失败要回滚:上面已把 state/绘制拆到子代理态,不回滚会把用户
      // 停在一个「标题还是父会话、但 chip 已按子代理算」的中间态。
      state.sessionId = address.parentSessionId;
      subagentCatalog.refresh();
      showToast(format(error));
      return;
    }

    if (token !== openSessionToken) return;

    const snapshot = deps.sessions.getRuntimeSnapshot();
    elements.emptyHint.hidden = snapshot.nodes.length > 0;
    historyDrawer?.setActive(childId, snapshot.title);
    subagentCatalog.refresh();

    const summary = deps.sessions.listStore.get().find((item) => item.sessionId === childId);
    if (summary?.cwd) {
      state.cwd = summary.cwd;
      workspaceMenu?.setActiveByCwd(summary.cwd);
    }
    picker.clear();
    renderPickedChip();
    setInputText("");
    autoResizeInput();
    updateSendState();

    dock.refreshModelMenu();
    dock.refreshPresetMenu().then(() => {
      statsBar.set({ ...deps.sessions.getRuntimeSnapshot(), presetName: dock.currentPresetName() });
    });
    refreshSlashSources();
  }

  // ---- 快捷键 ----
  function setupShortcuts() {
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const shortcutLabels = getSessionShortcutLabels(platform);
    elements.shortcutNew.textContent = shortcutLabels.newSession;
    elements.shortcutHistory.textContent = shortcutLabels.history;
    elements.hdrNew.title = `${t("new_session")} (${shortcutLabels.newSession})`;
    elements.hdrTitleWrap.title = `${t("history")} (${shortcutLabels.history})`;
    const controller = createSessionShortcutController({
      platform,
      onHintsChange: (visible) => document.body.classList.toggle("shortcut-hints-visible", visible),
      onToggleHistory: () => historyDrawer?.toggle(),
      onNewSession: () => newSession(),
      onSelectHistory: (index) => historyDrawer?.selectByIndex(index)
    });
    // 历史浮层开着时,方向键/回车先归它 —— 焦点通常在搜索框(那里已单独监听),
    // 但点过列表后焦点会跑到 body,这条兜底保证键盘导航仍然有效。
    document.addEventListener("keydown", (event) => {
      if (historyDrawer?.handleKeyDown(event)) event.stopPropagation();
    }, true);
    document.addEventListener("keydown", controller.handleKeyDown, true);
    document.addEventListener("keyup", controller.handleKeyUp, true);
    window.addEventListener("blur", controller.reset);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) controller.reset();
    });
    return shortcutLabels;
  }

  // ---- 启动 ----
  async function start() {
    setStreamState(deps.DshStreamState.CONNECTING);
    elements.input.placeholder = t("input.placeholder");
    updateSendState(false);
    const shortcutLabels = setupShortcuts();
    renderPickerButton();
    renderPickedChip();
    workspaceMenu = mountWorkspaceMenu(elements, deps, {
      showToast,
      hostCwd: () => state.hostCwd,
      onChange: () => historyDrawer?.refresh()
    });
    historyDrawer = mountHistoryDrawer(deps, openSession, newSession, shortcutLabels, {
      workspacePath: () => workspaceMenu?.activePath() ?? null,
      workspaceSessionIds: () => workspaceMenu?.activeSessionIds() ?? null
    });
    // 设置页需要 showToast 报告写失败,而 deps 是纯组装层拿不到它 —— 就地补一个。
    mountSettings(
      { ...deps, showToast, onBusyEnterChange: setBusyEnter },
      () => { setStreamState(deps.DshStreamState.CONNECTING); startConnection(); },
      // 设置页改完提供方/模型目录后,当场重画底栏模型菜单 ——
      // 用户关掉设置页就能在对话框里看到新模型,不必切会话。
      { onModelsChanged: () => { dock.refreshModelMenu(); } }
    );
    startConnection();
    setInterval(() => setStreamState(deps.connection.streamState), 500);
    // 断开时点击状态点手动重连。
    elements.hdrStatus.addEventListener("click", () => {
      if (state.streamState === deps.DshStreamState.CONNECTED) return;
      setStreamState(deps.DshStreamState.CONNECTING);
      deps.connection.restart();
    });
    elements.hdrNew.addEventListener("click", newSession);
    // 工作目录入口:用系统打开 header 前缀当前代表的那个目录。
    elements.hdrOpenFolder.addEventListener("click", async () => {
      const path = workspaceMenu?.displayedPath();
      if (!path) return;   // 连接前的极短窗口:尚无任何目录
      try {
        await deps.workspaces.openPath(path);
      } catch (error) {
        showToast(format(error));
      }
    });
  }

  async function startConnection() {
    try {
      await deps.connection.ensureStarted();
      setStreamState(deps.connection.streamState);
      // host.describe 提供 home,工具行用它把残留的绝对路径缩写成 ~;
      // cwd 则是「临时目录」过滤项的路径。这一步在下面的 workspaceMenu.refresh()
      // 之前完成,所以菜单首次渲染就能拿到 hostCwd,不需要补渲。
      const described = await deps.connection.call("host.describe", {}).catch(() => null);
      state.hostHome = described?.home ?? described?.homeDir ?? null;
      state.hostCwd = described?.cwd ?? null;
    } catch (error) {
      showToast(format(error));
    }
    await Promise.allSettled([
      deps.sessions.refreshList(),
      workspaceMenu ? workspaceMenu.refresh() : deps.workspaces.refresh(),
      deps.models.refresh(),
      loadBusyEnter()
    ]);
    const listed = deps.sessions.listStore.get();
    if (listed.length) await openSession(listed[0].sessionId);
    else await newSession();
  }

  return Object.freeze({ start, openSession, newSession, sendMessage, stopRun, state });
}
