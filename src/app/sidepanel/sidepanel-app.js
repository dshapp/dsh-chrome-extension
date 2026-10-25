// 侧栏应用主体:DOM 编排 + 帧分发。
// 与旧版的关键差别:渲染输入是 store 派生的 nodes[],交互卡通过 takeover 接管输入框,
// plan chip / 触发菜单 / 权限二次确认按 Mac 的座位语义接线。
import { t, getLang } from "../../shared/i18n.js";
import { createChatRenderer, mountTurnRail, resolveActiveTurn, createTailFollow, mountFindBar, mountRunningStatus, runningStatusLabel, installImageViewer, resolveToolPath, openUrlInNewTab } from "../../features/chat/index.js";
import {
  createApprovalCard, createQuestionCard, tryCreatePlanReviewCard, resolveTakeover
} from "../../features/interactions/index.js";
import { createQueuePanel } from "../../features/prompt-queue/index.js";
import { mountHistoryDrawer } from "./sidepanel-overlays.js";
import { mountSettings } from "./settings/settings-root.js";
import { mountMainSurfaces } from "./main-surfaces.js";
import { mountAutomationsPage } from "../../features/automations/index.js";
import { mountWorkspaceMenu } from "./workspace-menu.js";
import { createComposerMenus } from "./composer-menus.js";
import { createComposerDock, isFullAccessOption } from "./composer-dock.js";
import { createShortcutDispatcher } from "./shortcut-bindings.js";
import { formatPageContext } from "../../features/page-context/page-context-format.js";
import { mountTriggerMenu } from "./trigger-menu.js";
import { projectDraft, reconcileEdit, reconcileDraft, renderChipMirror, insertReference, scanFileMentions, fileMentionPath, chipAlignedRange, insertPasted } from "./composer-chips.js";
import { collectElements } from "./sidepanel-elements.js";
import { mountAttachmentControls } from "./composer-attachments.js";
import { createSessionShortcutController, getSessionShortcutLabels } from "../../features/sessions/session-shortcuts.js";
import { visibleSessions } from "../../features/sessions/sidebar-sections.js";
import { mountGoalBar, mountTodoPanel, mountStatsBar, activeGoal } from "../../features/docks/session-docks.js";
import { mountTrajectoryPane } from "../../features/trajectory/index.js";
import { mountJobList } from "../../features/docks/job-list.js";
import { mountSubagentCatalog } from "../../features/subagents/subagent-catalog-view.js";
import { mountGitEntry } from "./git-entry.js";
import { applyStaticLabels } from "./static-labels.js";
import { lucideIcon, lucideIconSvg } from "../../features/chat/file-icons.js";
import { createHostProxyClient } from "../../platform/dsh/host-proxy-client.js";
import { createGitService } from "../../features/host-proxy/git-service.js";
import { createGitSummaryReader } from "../../features/host-proxy/git-summary.js";
import { createElementPicker } from "../../features/element-picker/element-picker.js";
import { isElementPickerToggleChord, elementPickerShortcutLabel } from "../../features/element-picker/element-picker-shortcut.js";
import { createPageContext } from "../../features/page-context/page-context.js";
import { resolveSubmitMode, isSteerChord, DEFAULT_BUSY_ENTER, steerChordLabel } from "../../features/prompt-queue/index.js";
import { isFirstUse, initializeDefaultWorkspace } from "../../features/workspaces/default-workspace.js";
import { mountHistoryLoadOlder } from "./history-load-older.js";
import { mountSetupGuide } from "../../features/onboarding/setup-guide.js";
import { createApiKeyOnboarding } from "./api-key-onboarding.js";
import { createSettingsService } from "../../features/settings/settings-service.js";
import { isNativeHostSetupError } from "../../platform/dsh/native-host-error.js";
import { probeHost } from "../../platform/dsh/native-supervisor.js";

export function createSidepanelApp(root, deps, options = {}) {
  // 主题句柄由入口创建(首帧要在 app 组装前就定色),app 只负责把本地镜像与
  // 宿主偏好灌进去。缺失时(单元测试、dev web)主题保持跟随系统。
  const theme = options.theme ?? null;
  const elements = collectElements(root);
  let sending = false;
  let historyDrawer = null;
  let workspaceMenu = null;
  let settingsView = null;
  let mainSurfaces = null;
  let setupGuide = null;
  let apiKeyOnboarding = null;
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

  // 「加载更早」:窗口之前还有历史时挂在记录顶端(对齐 Mac LoadMoreButton)。
  const historyLoadOlder = mountHistoryLoadOlder(elements.msgList, {
    onLoad: () => (state.sessionId ? deps.sessions.loadEarlier(state.sessionId) : null)
  });

  // 运行状态条:悬浮在输入框区域顶部(Mac RunningStatusRow),不进记录流。
  const runningStatus = mountRunningStatus(elements.runningStatus);

  // 记录里的图片(用户发送的附件 / agent 回复的图片)点击放大。挂在 document 上委托:
  // 卡片详情弹窗(在 body 下,不在消息列表里)里的工具结果图同样可以放大。
  installImageViewer(document);

  const chatRenderer = createChatRenderer(elements.msgList, {
    onFork: handleFork,
    getContext: () => {
      const snap = deps.sessions.getRuntimeSnapshot();
      return {
        cwd: executionDirectory(),
        home: state.hostHome,
        // 本轮产出词表(只喂正文的行内 mention;上游 f937f4e23b 已删掉它的页脚 chip 行)
        // 与 present 交付清单(web ui-deliverables / mac TurnDeliverables)。
        producedPaths: (turn) => snap?.producedPathsByTurn?.get?.(turn) ?? [],
        presentedFiles: (turn) => snap?.presentedByTurn?.get?.(turn) ?? [],
        submittedPlans: (turn) => snap?.plansByTurn?.get?.(turn) ?? [],
        deliverablesRevision: snap?.deliverablesRevision ?? null,
        // 本轮改动文件卡(web ChangedFiles / mac ChangedFilesCard):耐久事件只公告
        // turn 与 seq,清单与逐文件 diff 要按 seq 去宿主读;读到的结果由服务缓存,
        // 所以重渲染不会重复拉取。
        changesSeq: (turn) => snap?.changesSeqByTurn?.get?.(turn) ?? null,
        changesSummary: (seq) => deps.changes?.summary?.(snap?.sessionId, seq) ?? null,
        loadChangesSummary: (seq) => deps.changes?.loadSummary?.(snap?.sessionId, seq) ?? null,
        changesDiff: (seq, index) => deps.changes?.diff?.(snap?.sessionId, seq, index) ?? null,
        loadChangesDiff: (seq, index) => deps.changes?.loadDiff?.(snap?.sessionId, seq, index) ?? null,
        // 行内 mention / 交付卡点击:侧栏是扩展页,file: 打不开,
        // 统一走宿主 openPath。打开失败不再静默吞:宿主对不存在的路径会回错,
        // 用户看到 toast 才知道"点了没反应"是路径问题而不是按钮坏了。
        onOpenPath: (path) => { void deps.workspaces.openPath(path).catch((error) => showToast(format(error))); },
        onOpenFile: (path) => { void deps.workspaces.openPath(path).catch((error) => showToast(format(error))); },
        // 正文里的网页链接:在当前窗口开新标签页(web openExternalLink;这里浏览器本身就是 Chrome)。
        onOpenUrl: (url) => openUrlInNewTab(url),
        // 气泡里的会话引用胶囊:点了就切到被引用的那个会话(可跨工作区)。
        onOpenSession: (sessionId) => { void openSession(sessionId).catch((error) => showToast(format(error))); },
        onRevealPath: (path) => { void deps.workspaces.revealPath(path).catch((error) => showToast(format(error))); },
        // 历史图片只有 attachmentId,按需回读字节(web historical-images)。
        readAttachment: (attachmentId) => deps.sessions.readAttachment?.(snap?.sessionId, attachmentId) ?? null,
        // 助手正文里的本地绝对路径图片:宿主 GET /api/file?path=…(dsh 0.1.7,
        // web localPathMediaUrl),要鉴权,所以读成 Blob 而不是直接 <img src>。
        readLocalImage: (path) => deps.connection.getBlob("/api/file", { path }),
        // 定时任务触发气泡的详情弹窗:按 schedule_id 查任务名称与运行规则(schedule/catalog)。
        loadScheduleRecords: () => deps.automations?.catalog?.() ?? null
      };
    }
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
    // 最近一次由本端选中的推理档(投影不直接给"当前档",用它做步进的起点)。
    currentReasoningEffort: null,
    models: [],
    cwd: null,
    currentDirectory: null,
    hostHome: null,
    // 宿主自身的工作目录（来自 `$events` ready.host.home）。未选工作目录创建的会话都落在
    // 这里,所以它同时是历史过滤「临时目录」这一项的路径。
    hostCwd: null,
    // 子代理会话:队列与当前轮都不归本端管,插队不可用。
    subagent: null
  };
  // ---- 会话 turn 轨道 ----
  // 轨道条目、当前阅读轮次、正在分页加载的轮次。active 在首个快照落到最后一轮,
  // 点击跳转/分页后再随快照推进。
  let turnRailItems = [];
  let activeTurn = null;
  let busyTurn = null;
  // 只要读者没手动点过刻度,active 就自动跟随最新轮;点击后锁定,再发送时恢复跟随。
  let activeTurnFollowsLatest = true;

  // scrollToTurn 的平滑滚动会路过中间各轮;锁一小段时间,避免路过时把 active
  // 改成中途的轮次,等动画停在目标轮后由点击时写入的值接管。
  let railLockUntil = 0;

  // 点击未加载刻度后待落的跳转目标。分页是异步的,目标锚点行要等下一次快照帧
  // 渲染出来才存在,所以落点动作延迟到 applySnapshot 之后(对齐 web realizePendingJump)。
  let pendingJumpTurn = null;

  function scrollToTurn(anchorRow, turn) {
    const el = chatRenderer.elementById(anchorRow);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    activeTurn = turn;
    activeTurnFollowsLatest = false;
    railLockUntil = Date.now() + 700;
    turnRail.set(turnRailItems, activeTurn, busyTurn);
  }

  /// 交互口径=Mac/web:active 刻度随阅读位置滚动,不再只在点击时更新。
  function syncActiveTurnToScroll() {
    if (Date.now() < railLockUntil) return;
    const hostTop = elements.messages.getBoundingClientRect().top;
    const candidate = resolveActiveTurn(turnRailItems, hostTop, (anchorRow) => {
      const el = chatRenderer.elementById(anchorRow);
      return el ? el.getBoundingClientRect().top : null;
    });
    if (candidate == null || candidate === activeTurn) return;
    activeTurn = candidate;
    activeTurnFollowsLatest = false;
    turnRail.set(turnRailItems, activeTurn, busyTurn);
  }

  /// 落未加载刻度跳转:分页把目标锚点带进窗口后,行要等一次快照渲染才存在。
  /// 找到目标轮的锚点行并滚过去;取不到就返回 false,留给下一次快照再试。
  function realizePendingJump() {
    if (pendingJumpTurn == null) return false;
    const entry = turnRailItems.find((i) => i.turn === pendingJumpTurn);
    if (!entry?.anchorRow) return false;
    if (!chatRenderer.elementById(entry.anchorRow)) return false;
    pendingJumpTurn = null;
    scrollToTurn(entry.anchorRow, entry.turn);
    return true;
  }

  async function jumpToUnloaded(item) {
    // 跳转到一个未加载的轮次=离开当前阅读位置,跟随随之释放。
    tailFollow.release();
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    pendingJumpTurn = item.turn;
    busyTurn = item.turn;
    turnRail.set(turnRailItems, activeTurn, busyTurn);
    try {
      await deps.sessions.loadThrough(state.sessionId, item.seq);
    } finally {
      busyTurn = null;
    }
    // 分页后 store 已重折,但新锚点行要等下一次 applySnapshot 才画出来:
    // 已渲染就先落点,否则把 pendingJumpTurn 留给那一帧。
    const snap = deps.sessions.getRuntimeSnapshot();
    const entry = (snap?.turnRail ?? []).find((i) => i.turn === item.turn);
    if (entry?.anchorRow) {
      // 钩子排在 notifyRuntime 已注册的快照帧之后:那一帧画完再落点。
      if (!realizePendingJump()) requestAnimationFrame(() => realizePendingJump());
    } else {
      // 目标不在窗口里(到底了或回包被顶掉):别把落点悬着。
      pendingJumpTurn = null;
      turnRail.set(turnRailItems, activeTurn, null);
    }
  }

  const turnRail = mountTurnRail(elements.turnRail, {
    // 轨道外框锁在消息区的竖向范围内;轮次多到放不下时在内部滚动。
    band: elements.messages,
    onNavigate: (item) => {
      if (item.anchorRow) scrollToTurn(item.anchorRow, item.turn);
      else if (item.seq != null) void jumpToUnloaded(item);
    }
  });

  // ---- 会话内查找(⌘F) ----
  const findBar = mountFindBar({
    bar: elements.findBar,
    input: elements.findInput,
    count: elements.findCount,
    prev: elements.findPrev,
    next: elements.findNext,
    close: elements.findClose
  }, { getRoot: () => elements.msgList });
  elements.findInput.placeholder = t("find.placeholder");
  elements.findInput.setAttribute("aria-label", t("find.placeholder"));
  elements.findPrev.setAttribute("aria-label", t("find.previous"));
  elements.findNext.setAttribute("aria-label", t("find.next"));
  elements.findClose.setAttribute("aria-label", t("find.close"));
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
    // 本处理器只认"纯" ⌘F(会话内查找)。带 Shift/Alt 的 F 是另一条命令
    // (findInSession = ⇧⌘F),不能在这里被 preventDefault 吞掉。
    if (event.shiftKey || event.altKey) return;
    // 设置视图是全屏覆盖,不在会话内,不抢它的 ⌘F。
    // 它没有 hidden 属性(靠 CSS 显隐),所以用"是否有布局盒"判断可见性。
    if (elements.viewSettings?.getClientRects().length) return;
    event.preventDefault();
    // 轨迹页打开时 ⌘F 进轨迹搜索(对齐 Mac trajectorySearchFocusEpoch)。
    if (trajectory.isOpen()) {
      trajectory.focusSearch();
      return;
    }
    findBar.open();
  });

  // ---- 尾部跟随 ----
  // 发送即锁尾,直到轮次真正结束或读者自己向上滚(对齐 mac TranscriptTailFollow)。
  const tailFollow = createTailFollow();
  let stopConfirmTimer = null;
  // stop 熬过这段静默(没有新快照)才确认回答结束;期间任何内容修订都证伪它。
  const STOP_CONFIRM_MS = 400;

  // ---- 帧分发 ----
  deps.onFrame((frame, stream) => {
    if (stream === "mux") deps.sessions.handleMuxFrame(frame);
    else deps.sessions.handleHostFrame(frame);
    const value = frame.type === "item" ? frame.value : null;
    if (frame.streamId === "events" && value?.type === "ready") {
      settingsView?.generationOpened?.();
      void deps.sessions.refreshGoalActivation?.();
    } else if (value?.type === "emit" && value.event === "api-session/status" && value.args?.[0] === state.sessionId) {
      void deps.sessions.refreshGoalActivation?.();
    }
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

  // 已就地报告过的 follow 失败,按会话记一次,避免每个快照都弹同一条 toast。
  let reportedHistoryError = null;

  function applySnapshot(snapshot) {
    if (snapshot.running) awaitingTurnStart = false;
    // follow 流失败是终态:host 不会再补任何帧。必须自己把"准备中"的等待态落下,
    // 否则 awaitingTurnStart 会让 statusPreparing 一直转圈(见 agentStatusLabel)。
    if (snapshot.historyError) {
      awaitingTurnStart = false;
      const key = `${snapshot.sessionId}:${snapshot.historyError}`;
      if (reportedHistoryError !== key) {
        reportedHistoryError = key;
        showToast(snapshot.historyError);
      }
    }
    state.hostHome = deps.sessions.hostHome ?? state.hostHome;
    const previousCwd = state.currentDirectory;
    state.cwd = snapshot.cwd ?? state.cwd;
    state.currentDirectory = snapshot.currentDirectory ?? snapshot.workingDirectory ?? snapshot.cwd ?? state.cwd;
    // 冷启动也走这里(首个快照带来 cwd),所以入口的首次出现靠这一行 ——
    // 只在真的变化时刷,避免每个快照都发一串 git。
    if (state.currentDirectory && state.currentDirectory !== previousCwd) refreshGitEntry();
    state.subagent = snapshot.subagent ?? null;

    // 查找标记包住的是真实文本节点,重建前先还原,避免与增量 markdown 打架。
    if (findBar.isOpen()) findBar.detach();
    // 待插入的插队消息(已提交、agent 还没在 step 边界取走)贴在记录尾部,
    // 不必等到 durable 的 user/message 才出现(对齐 web PendingSteeringBubble)。
    const pendingSteering = snapshot.pendingSteering ?? [];
    chatRenderer.render(pendingSteering.length ? [...snapshot.nodes, ...pendingSteering] : snapshot.nodes);
    historyLoadOlder.update(snapshot.hasMore === true && (snapshot.nodes?.length ?? 0) > 0);
    if (findBar.isOpen()) findBar.refresh();
    // turn 轨道:随快照更新条目;active 在首个快照落到最后一轮,当前 active 消失时回退。
    turnRailItems = snapshot.turnRail ?? [];
    if (activeTurn == null || !turnRailItems.some((i) => i.turn === activeTurn) || activeTurnFollowsLatest) {
      activeTurn = turnRailItems.at(-1)?.turn ?? null;
    }
    turnRail.set(turnRailItems, activeTurn, busyTurn);
    // 未加载刻度的分页跳转:锚点行刚渲染出来,在这里落点(见 realizePendingJump)。
    realizePendingJump();
    // 运行中的状态不再作为记录流末尾的一行:对齐 Mac,改由输入框上方的状态条给出
    // "工作类别 · 用时"。记录区里的等待指示只剩切会话时的"加载中",快照到了就收掉。
    chatRenderer.setTyping(false);
    chatRenderer.setThinking(false);
    runningStatus.set(runningStatusLabel(snapshot, { awaitingTurnStart }), snapshot.runningStartTime);
    // 空会话 + 加载失败:空态提示比一片空白更能说明"这不是在加载"。
    elements.emptyHint.hidden = snapshot.nodes.length > 0 || pendingSteering.length > 0;

    renderTakeover(snapshot);
    renderQueuePanel(snapshot.queue, snapshot);
    goalBar.set(snapshot.goal);
    todoPanel.set(snapshot.todos);
    // 当前模式名由 dock 从 roster 解析(出厂预设走本地化文案,如 code → PTC 模式),
    // 显示在统计浮层顶部。
    syncDocks(snapshot);
    // 轨迹页打开时随每个快照重画;未变脏时视图内部按缓存 identity 直接返回。
    if (trajectory.isOpen()) trajectory.render();
    subagentCatalog.refresh();
    // 图片限制以宿主投影为准,composer 据此在本地就把超限文件挡下。
    deps.attachments.setLimits?.(snapshot.imageLimits);
    dock.renderPlanChip(snapshot.planMode);
    // 占位符与可用性统一在这里裁决(子代理只读 > 计划模式 > 默认)。
    applyComposerAvailability(snapshot);
    // 无条件重画:0.1.6 的 permissions 投影只剩 currentValue,选项要等目录
    // RPC 回来才齐;若这里只在有值时调用,一个没有权限服务的会话会留着上一个
    // 会话的药丸。传 null 让 dock 自己隐藏入口。
    dock.renderPermMenu(snapshot.permissions);
    // 尾部跟随:仍在产出的修订先证伪 pending stop;running 只上膛不释放;跟随中重钉。
    tailFollow.transcriptChanged();
    tailFollow.runningChanged(snapshot.running);
    autoScroll();
    scheduleStopConfirm();
    historyDrawer?.setActive(state.sessionId, snapshot.title);
    // 换了会话:立刻告诉 SW 现在看的是哪条(清它的工具栏未读),不等心跳。
    deps.presence?.sessionChanged?.();
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
    // continued 提问没有 waterfall(rpcId),以 ask_user_question 的 callId 为键。
    if (q.continued) return `question:call:${q.callId}`;
    return `question:${q.rpcId ?? (q.questions ?? []).map((i) => i.id).join(":")}`;
  }

  // 被收起的 continued 提问:输入框上方一条提示,点「回答」重新打开(web 从工具行重开)。
  const hiddenQuestionBar = document.createElement("div");
  hiddenQuestionBar.id = "question-hidden-bar";
  hiddenQuestionBar.hidden = true;
  elements.composer.before(hiddenQuestionBar);
  let renderedHiddenKey = null;

  function renderHiddenQuestionBar(snapshot) {
    const hidden = snapshot.presentedQuestion ? null : (snapshot.continuedQuestions ?? [])[0] ?? null;
    const key = hidden ? `${hidden.callId}:${getLang()}` : null;
    if (key === renderedHiddenKey) return;
    renderedHiddenKey = key;
    hiddenQuestionBar.hidden = !hidden;
    hiddenQuestionBar.replaceChildren();
    if (!hidden) return;
    const text = document.createElement("span");
    text.className = "question-hidden-text";
    text.textContent = hidden.questions?.[0]?.question || t("question.waitContinued");
    text.title = t("question.waitContinued");
    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.className = "btn";
    reopen.textContent = t("question.hiddenReopen");
    reopen.addEventListener("click", () => deps.sessions.reopenQuestion(hidden.sessionId, hidden.callId));
    hiddenQuestionBar.append(lucideIcon("circle-help", { size: 14 }), text, reopen);
  }

  function renderTakeover(snapshot) {
    renderHiddenQuestionBar(snapshot);
    const takeover = resolveTakeover({
      question: snapshot.presentedQuestion ?? snapshot.pendingQuestion,
      approval: snapshot.pendingApproval
    });
    const key = takeoverKey(takeover);
    if (key === renderedTakeoverKey) {
      // 同一张提问卡的新版本(限时提问的倒计时起点到了、被持有):原地刷新等待状态行。
      if (takeover?.kind === "question") takeoverCard?.update?.(takeover.question);
      return;
    }

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

    // continued 提问(dsh 0.2)没有 waterfall:回答走 userQuestions/answer,取消只是收起。
    const onRespond = takeover.kind === "question" && takeover.question.continued
      ? (_eventId, result) => deps.sessions.respondContinuedQuestion(takeover.question, result)
      : (eventId, result) => deps.sessions.respondInteraction(eventId, result);
    if (takeover.kind === "approval") {
      takeoverCard = createApprovalCard(takeover.approval, { onRespond, store: deps.sessions.store });
    } else {
      // 计划审阅有专用卡;不是计划审阅才落到通用问答向导。
      const onHold = (question) => deps.sessions.holdQuestion?.(question.eventId);
      takeoverCard = tryCreatePlanReviewCard(takeover.question, { onRespond })
        ?? createQuestionCard(takeover.question, { onRespond, onHold });
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
    // 整队插话提示优先于计划占位符:running 普通会话确有排队行时,提示该手势(web 顺序)。
    const queuedSome = (snapshot.queue ?? []).some((item) => (item.placement ?? "queued") === "queued");
    const steerHint = Boolean(snapshot.running && !snapshot.subagent && queuedSome);
    elements.input.placeholder = readOnly
      ? t("subagent.readOnly")
      : steerHint
        ? t("composer.placeholderSteerQueue", { chord: steerChordLabel(isMac) })
        : snapshot.planMode === true
          ? t("composer.placeholderPlan")
          : t("input.placeholder");
    if (readOnly) elements.send.disabled = true;
  }

  /// 队列面板按快照**就地更新**,不是每帧重建:流式输出时一个 rAF 就会来一个
  /// 快照,重建会把行内编辑的输入框(连同已敲进去的字)换掉,也会白重建整块
  /// DOM。队列内容的唯一权威仍是宿主推送的 session/queue 帧,面板的 update()
  /// 只在签名变化时重画(见 queue-panel.js)。
  function renderQueuePanel(queue, snapshot) {
    const options = {
      onAction: handleQueueAction,
      // 插队要有"当前轮"可插;子代理会话的队列不归本端管,只读展示。
      running: Boolean(snapshot?.running),
      mutable: !snapshot?.subagent
    };
    const previous = elements.promptQueue.firstElementChild;
    if (typeof previous?.update === "function") {
      previous.update(queue, options);
      elements.promptQueue.hidden = previous.hidden;
      return;
    }
    const panel = createQueuePanel(queue, options);
    elements.promptQueue.replaceChildren(panel);
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
      if (code === "session/steer-unavailable" || code === "session/queue-item-not-found") return;
      showToast(format(error));
    }
  }

  /// 空草稿 + 插队手势(⌥⌘↩):把仍排队的消息按 FIFO 逐条插进当前轮(web steerQueue)。
  /// 复用队列面板的单条 steer 动作;agent 已取走该条 / 停止接受插队时静默收敛,
  /// 其余失败只提示一次(与 macapp steerWholeQueue 一致)。
  async function steerWholeQueue() {
    if (!state.running || state.subagent) return;
    const items = deps.sessions.getRuntimeSnapshot?.().queue ?? [];
    const queued = items.filter(
      (item) => (item.placement ?? "queued") === "queued" && !String(item.id ?? "").startsWith("pending:")
    );
    for (const item of queued) {
      try {
        await deps.sessions.updateQueue(state.sessionId, item.id, { kind: "steer" });
      } catch (error) {
        const code = error?.code;
        if (code === "session/steer-unavailable" || code === "session/queue-item-not-found") return;
        showToast(format(error));
        return;
      }
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
        elements.send.innerHTML = lucideIconSvg("plus", { size: 14 });
        elements.send.title = t("queue.send");
      } else {
        elements.send.className = "state-stop";
        elements.send.innerHTML = lucideIconSvg("square", { size: 10 });
        elements.send.title = t("stop");
      }
      elements.send.disabled = false;
    } else {
      elements.send.className = "state-idle";
      elements.send.innerHTML = lucideIconSvg("arrow-up", { size: 14 });
      elements.send.title = t("send");
      elements.send.disabled = !connected || !hasInput;
    }
    // FileReader 对大图可能需要明显时间。此时 pending 只包含已读完的附件；允许
    // 发送会把文字先发出，再由成功路径 clear() 清掉仍在读的图片占位。
    if (deps.attachments.reading) elements.send.disabled = true;
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
      const described = await deps.connection.call(RPC.settingsDescribe, {});
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
    if (!state.sessionId || sending || deps.attachments.reading) return;
    // 插队手势不该被"停止"按钮态吃掉:agent 正跑时发送键显示为停止,
    // 但 ⌥⌘↩ 的语义是插队发送,不是中断。
    // 这一条必须排在"没有内容就返回"之前:停止态恰恰是输入框为空时才出现的
    // (有内容时按钮是 state-queue),先判空会让停止按钮永远点不动。
    // 注:picker 提交不会撞上这条 —— 停止态的前提是 picked 为空(见 updateSendState),
    // 而提交路径必然带着至少一个元素,按钮那时是 state-queue。
    if (elements.send.className === "state-stop" && gesture !== "modifier") return stopRun();
    if (!text && !attachments.length && !pickedElements.length) {
      // 空草稿 + 插队手势 = 整队插话(web steerQueue);普通回车/点击发送无内容则什么都不做。
      if (gesture === "modifier") steerWholeQueue();
      return;
    }
    // 子代理会话的队列不归本端管,没有可插的当前轮。
    const steeringAvailable = !state.subagent;
    const mode = resolveSubmitMode(state.running, gesture, steeringAvailable, busyEnter);
    if (!attachments.length && await menus.tryDispatchCommand(text)) {
      setInputText("");
      autoResizeInput();
      updateSendState();
      return;
    }
    // 新建会话页上换过工作目录:这条消息该落在 chip 指的那个目录,而会话的 cwd
    // 建时就定死了 —— 先把页面搬到目标目录的新会话上,再发。上面取的文本/附件/
    // 元素都已是副本,切会话清空输入框不会带走它们。
    if (!await retargetNewSessionPage()) return;
    sending = true;
    // 新的一轮开始了:turn 轨道回到"跟随最新",读者上滚/点刻度的锁定随之解除。
    activeTurnFollowsLatest = true;
    activeTurn = null;
    const sentOccurrences = occurrences;
    setInputText("");
    setDraft(state.sessionId, "");
    autoResizeInput();
    updateSendState();
    awaitingTurnStart = true;
    // 发出即亮状态条(Mac:还没有 live 工具时就是"正在分析请求");用时等 turn/start 到了再出。
    runningStatus.set(t("activity.thinking"));
    // 发送即锁尾:从这一刻起转录钉在最新内容,直到轮次结束或读者自己上滚。
    tailFollow.didSubmit();
    try {
      const content = [];
      // 选取的元素(指哪个,语义化 XML)拼在最前面,后接 [指令] 分隔用户原话。
      // 「当前网页」的 tabId 不走这里 —— 它是输入框里的一枚胶囊,
      // 已由上面的 projectDraft 展开进 text,是正文的一部分。
      const pickedContext = pickedElements.length ? picker.context(pickedElements) : "";
      const prefix = pickedContext;
      // 批注已经把"要它做什么"写在 XML 的 <note> 里了,此时再补一句 picker.instruction
      // 纯属噪音。只有元素一条批注都没有、输入框又是空的,才需要那句兜底指向上文。
      const annotated = pickedElements.some((element) => String(element?.note ?? "").trim());
      const instruction = text || (annotated ? "" : t("picker.instruction"));
      const promptText = prefix
        ? (instruction ? `${prefix}\n\n[指令] ${instruction}` : prefix)
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
      // 没发出去就没有回答可跟;释放,别让阅读位置被一段不存在的内容钉住。
      tailFollow.release();
      runningStatus.clear();
      showToast(format(error));
      // 回填的是原始草稿(带占位符)+ 原胶囊,不是展开后的文本,
      // 否则失败一次胶囊就退化成裸路径。
      setInputText(draft, sentOccurrences);
      // 清空草稿时按钮已被置为 disabled；回填不会派发 input 事件，必须显式
      // 重算，否则纯文本发送失败后只能再敲一个字符才能重试。
      updateSendState();
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

  // ---- 轨迹页(对话列内切换,composer 保留)----
  // 与 Mac ConversationRoot 一致:轨迹替换对话列,ComposerDock 仍钉在下方。
  // 开合只是本次点击的即时状态,不落盘、不跨会话:每次打开会话都从对话开始,
  // 只有从统计浮层的入口点进来才进入轨迹模式。
  try { localStorage.removeItem("dsh.trajectory.open"); } catch { /* 清掉旧版本残留 */ }
  const trajectory = mountTrajectoryPane({
    pane: elements.trajectoryPane,
    ledger: elements.trajectoryLedger,
    getTrajectory: () => deps.sessions.store.getTrajectory(),
    hasMore: () => Boolean(state.sessionId) && deps.sessions.hasMoreHistory?.(state.sessionId) === true,
    onLoadEarlier: () => (state.sessionId ? deps.sessions.loadEarlier(state.sessionId) : Promise.resolve())
  });
  function openTrajectory() {
    if (!state.sessionId) return;
    trajectory.open();
    syncDocks(deps.sessions.getRuntimeSnapshot());
  }

  const statsBar = mountStatsBar(elements.statsBtn, elements.statsMenu, {
    onOpenTrajectory: openTrajectory
  });
  function currentGoal() {
    return deps.sessions.getRuntimeSnapshot().goal;
  }

  // 后台任务入口(header chip + 明细 popover,对齐 Mac/web JobListAction)。
  // 停止(job/kill)与详情实时输出(job/follow)直接走连接;名册仍由 session-service 的 job/list 流喂。
  const jobList = mountJobList(elements.jobsBtn, elements.jobsMenu, {
    connection: deps.connection,
    getSessionId: () => state.sessionId,
    notify: (message) => showToast(message)
  });

  /// 上下文统计药丸 + 后台任务 chip 一起刷新。两者数据同源(runtime snapshot),
  /// 分开调用会让一条快照在两处渲染出不同时刻的状态。
  function syncDocks(snapshot) {
    // 有会话就有轨迹可看;没有会话时入口连药丸一起隐藏。
    statsBar.set({ ...snapshot, presetName: dock.currentPresetName(), trajectoryEntry: Boolean(state.sessionId) });
    jobList.set(snapshot?.jobs);
  }

  // 子代理目录入口(header chip + 树形 popover,对齐 Mac SubagentCatalogAction)。
  const subagentCatalog = mountSubagentCatalog(elements.subagentCatalogBtn, elements.subagentCatalogMenu, {
    deps,
    getSessionId: () => state.sessionId,
    onOpenSubagent: (address) => { void openSubagent(address); }
  });

  // ---- Git 入口(对齐 Mac WorkspaceGitAction)----
  //
  // 刷新由这里驱动,而不是入口自己定时拉:入口在「非 git 仓库」时整个不渲染,
  // 挂在它内部的定时器永远不会跑,入口会永久隐藏(Mac 的注释记录了同一个坑,
  // 那边由 ConversationRoot 负责读取)。
  const gitHostProxy = createHostProxyClient();
  const gitService = createGitService(gitHostProxy);
  const gitEntry = mountGitEntry(elements.gitEntryBtn, elements.gitEntryMenu, {
    summaryReader: createGitSummaryReader(gitHostProxy),
    gitService,
    // 新建会话页上跟着工作目录 chip 走(见 pendingWorkspacePath):那时页面上还
    // 没有任何内容,"这个会话在哪个仓库"由 chip 说了算,而不是由这个一次性空
    // 会话建成时落在的目录。会话一旦开聊,cwd 就固定了,入口回到跟随会话。
    getCwd: () => pendingWorkspacePath() ?? executionDirectory(),
    showToast,
    onWorkingTreeChanged: () => refreshGitEntry(),
    promptBranchName: () => promptBranchName()
  });

  /// 重读 Git 入口。cwd 落定的每一处都调它。
  function executionDirectory() {
    const snapshot = deps.sessions.getRuntimeSnapshot();
    return snapshot?.sessionId === state.sessionId
      ? snapshot.currentDirectory ?? snapshot.workingDirectory ?? snapshot.cwd ?? state.cwd
      : state.cwd;
  }

  function refreshGitEntry() {
    return gitEntry.refresh().catch(() => {});
  }

  /// 空态 = 新建会话页(hero 可见)。此时对话里一条内容都没有,页面讲的是
  /// "下一条消息发去哪",而不是"这个会话是什么"。
  function isNewSessionPage() {
    return !elements.emptyHint.hidden;
  }

  /// 新建会话页上 chip 指向的目录,且它与当前空会话的 cwd 不是同一个 ——
  /// 也就是"这个会话该搬家了"。其余情况返回 null(chip 只是历史过滤器)。
  /// 「全部」/「临时目录」没有可展示的路径,同样返回 null:那时沿用会话 cwd
  /// 比画一个猜出来的仓库诚实。
  function pendingWorkspacePath() {
    if (!isNewSessionPage()) return null;
    const path = workspaceMenu?.displayedPath() ?? null;
    return path && path !== state.cwd ? path : null;
  }

  /// 把新建会话页搬到 chip 指的工作目录。会话的 cwd 在 session.create 时定死、
  /// 之后不可改,所以"换目录"只能是另建一个;被丢下的空会话不留痕 ——
  /// 宿主的 session/list 会把 blank 会话过滤掉(见 session-service)。
  /// 返回 false 表示该搬却没搬成,调用方应当放弃这次发送:发到旧目录去
  /// 比不发更糟,用户看到的 Git 入口与 chip 说的都是新目录。
  async function retargetNewSessionPage() {
    if (!pendingWorkspacePath()) return true;
    // 先清空输入框:切会话会把它当成"旧空会话的草稿"存起来。文字与胶囊
    // 在下面原样搬到新会话,发送流程读的是它自己早先取好的副本。
    const text = elements.input.value;
    const chips = occurrences;
    setInputText("");
    const created = await newSession();
    setInputText(text, chips);
    autoResizeInput();
    updateSendState();
    return Boolean(created);
  }

  /// 新建分支的名字。用原生 prompt:侧栏没有通用输入模态,而这一处的输入
  /// 只有一个字段、没有校验分支,自造一个模态不划算。
  async function promptBranchName() {
    const name = window.prompt(t("branch.createNewPrompt"));
    return name ? name.trim() : null;
  }

  // ---- 页面元素选取 ----
  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
  const picker = createElementPicker({
    showToast, t,
    onChange: () => { renderPickerButton(); renderPickedChip(); updateSendState(); },
    // 页面批注弹窗里的「提交」:整轮元素连同批注立刻发出去,不必再回侧栏按一次发送。
    onSubmit: () => { void sendMessage({ gesture: "picker" }); }
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
      // 元素名 + 批注摘要:药丸是这一轮的回看入口,只显示元素名的话用户无从核对
      // "我给这个元素写了什么",发现写错也只能整轮作废。
      const text = document.createElement("span");
      text.className = "picked-element-text";
      const nameLine = document.createElement("span");
      nameLine.className = "picked-element-name";
      nameLine.textContent = element.name || element.selector || element.tag || "element";
      text.append(nameLine);
      const note = String(element.note ?? "").trim();
      if (note) {
        const noteLine = document.createElement("span");
        noteLine.className = "picked-element-note";
        noteLine.textContent = note;
        noteLine.title = note;
        text.append(noteLine);
      }
      text.title = element.xpath || element.selector || "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "picked-element-remove";
      remove.append(lucideIcon("x", { size: 13 }));
      remove.setAttribute("aria-label", t("picker.remove"));
      remove.addEventListener("click", () => picker.remove(index));
      // hover 联动页面高亮,让用户确认"这一条对应的是哪个元素"。
      row.addEventListener("mouseenter", () => void picker.highlight(element));
      row.addEventListener("mouseleave", () => void picker.clearHighlight());
      row.append(text, remove);
      elements.pickedMenu.append(row);
    });
  }

  // ---- 当前页面上下文 ----
  // 只负责"取当前标签页 tabId"。带不带由候选浮层里的「当前网页」胶囊决定。
  const pageContext = createPageContext();

  const menus = createComposerMenus({ elements, deps, state, showToast, format });
  const dock = createComposerDock({ elements, deps, state, showToast, format });
  const { refreshSlashSources } = menus;

  // 引用胶囊:草稿里存 "\u00A0label\u00A0" 真实字符段,完整引用文本存在这里。
  let occurrences = [];
  let lastDraft = elements.input.value;

  /// 草稿每次变化都要重算胶囊位置并重画镜像层。
  /// isComposing:IME 组合期间不能写回 textarea.value(会打断输入法),
  /// 组合中触碰胶囊的罕见路径退化为 reconcileEdit(胶囊失效、残余字符留作普通文字)。
  function syncChips(isComposing = false) {
    const draft = elements.input.value;
    // 无胶囊快速路径:reconcile 的全文 diff 省掉,只让镜像层保持行高。
    if (occurrences.length === 0) {
      lastDraft = draft;
      renderChipMirror(elements.inputMirror, draft, occurrences);
      elements.inputMirror.scrollTop = elements.input.scrollTop;
      return;
    }
    if (isComposing) {
      occurrences = reconcileEdit(lastDraft, draft, occurrences);
      lastDraft = draft;
    } else {
      const caret = elements.input.selectionStart ?? draft.length;
      const next = reconcileDraft(lastDraft, draft, occurrences, caret);
      occurrences = next.occurrences;
      lastDraft = next.text;
      // 被触碰的胶囊连残余标签字符一起剔除:剔除后的文本要写回 textarea,
      // 否则碎片会被当成正文发出去。
      if (next.text !== draft) {
        elements.input.value = next.text;
        elements.input.setSelectionRange(next.caret, next.caret);
      }
    }
    renderChipMirror(elements.inputMirror, lastDraft, occurrences);
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

  // 必须排在 mountTriggerMenu 之前:浮层的「添加图片」行要拿它的 pickImage。
  const attachmentControls = mountAttachmentControls({
    elements, deps, showToast, formatError: format, onChange: () => updateSendState(),
    // 拖放的响应区是整个侧栏,不只是 composer。
    root: root.body ?? root
  });

  const triggerMenu = mountTriggerMenu({
    elements, deps, state, showToast,
    // '@' 浮层的额外候选来源(可插拔),排在固定行与文件之间。
    extraSources: deps.mentionSources ?? [],
    getOccurrences: () => occurrences,
    // 「当前网页」候选:选中时解析当前标签页,插成一枚展开为 tabId 的胶囊。
    captureCurrentTab: () => pageContext.captureCurrentTab(),
    // 「添加图片」候选:唤起文件选择器。
    onAttachImage: () => attachmentControls.pickImage(),
    // 候选被选中时由菜单回调插入胶囊,菜单自己不再拼裸文本。
    onInsertReference: (next) => {
      occurrences = next.occurrences;
      lastDraft = next.text;
      renderChipMirror(elements.inputMirror, next.text, occurrences);
    }
  });

  // ＋ 按钮打开的就是这一个浮层(与输入 "@" 完全相同)。
  // stopPropagation:否则这次点击会立刻被下面的 document 监听判成"点了外面"。
  elements.attachBtn.addEventListener("mousedown", (event) => event.preventDefault());
  elements.attachBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    triggerMenu.toggleAtCaret();
  });
  document.addEventListener("mousedown", (event) => triggerMenu.handleDocumentPointerDown(event));

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

  // ---- 输入区 ----
  elements.input.addEventListener("input", (event) => {
    autoResizeInput();
    syncChips(Boolean(event.isComposing));
    updateSendState();
    setDraft(state.sessionId, elements.input.value);
    triggerMenu.handleInput();
  });
  elements.input.addEventListener("scroll", () => {
    elements.inputMirror.scrollTop = elements.input.scrollTop;
  });
  // 插入胶囊后菜单派发 change(而非 input):此时胶囊字符段与 occurrences 已同步好,
  // 这里只补做「输入变化」的其余副作用。
  elements.input.addEventListener("change", () => {
    autoResizeInput();
    updateSendState();
    setDraft(state.sessionId, elements.input.value);
  });

  // 复制/剪切:胶囊在 textarea 里只是标签字符,剪贴板要放展开后的完整引用文本,
  // 粘贴回来(或粘到别处)才是 `@path`。
  function copySelection(event, cutting) {
    if (!occurrences.length) return;
    const { selectionStart, selectionEnd } = elements.input;
    if (selectionStart === selectionEnd) return;
    const { start, end } = chipAlignedRange(occurrences, selectionStart, selectionEnd);
    const inside = occurrences
      .filter((occurrence) => occurrence.offset >= start && occurrence.offset + occurrence.length <= end)
      .map((occurrence) => ({ ...occurrence, offset: occurrence.offset - start }));
    event.preventDefault();
    event.clipboardData.setData("text/plain", projectDraft(lastDraft.slice(start, end), inside));
    if (!cutting) return;
    elements.input.setRangeText("", start, end, "start");
    elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  elements.input.addEventListener("copy", (event) => copySelection(event, false));
  elements.input.addEventListener("cut", (event) => copySelection(event, true));
  // 粘贴的纯文本里符合文件引用写法的,还原成胶囊。带文件的剪贴板归附件那条路径。
  elements.input.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data || [...data.types].includes("Files")) return;
    const pasted = data.getData("text/plain");
    const mentions = scanFileMentions(pasted);
    if (!mentions.length) return;
    event.preventDefault();
    const { selectionStart, selectionEnd } = elements.input;
    const next = insertPasted(lastDraft, occurrences, selectionStart, selectionEnd, pasted, mentions);
    setInputText(next.text, next.occurrences);
    elements.input.setSelectionRange(next.caret, next.caret);
    elements.input.dispatchEvent(new Event("change", { bubbles: true }));
    triggerMenu.handleInput();
  });

  // 点击输入框里的文件胶囊:打开它(文件用默认应用,文件夹在访达里打开)。
  function fileChipPathAt(event) {
    if (!occurrences.length) return null;
    for (const node of elements.inputMirror.querySelectorAll(".composer-chip")) {
      const hit = [...node.getClientRects()].some((rect) =>
        event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom);
      if (!hit) continue;
      const occurrence = occurrences.find((item) => String(item.occurrenceId) === node.dataset.occurrenceId);
      return occurrence ? fileMentionPath(occurrence.text) : null;
    }
    return null;
  }
  elements.input.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    const path = fileChipPathAt(event);
    if (!path) return;
    event.preventDefault();
    const cwd = pendingWorkspacePath() ?? executionDirectory();
    void deps.workspaces.openPath(resolveToolPath(path, cwd)).catch((error) => showToast(format(error)));
  });
  elements.input.addEventListener("mousemove", (event) => {
    elements.input.style.cursor = fileChipPathAt(event) ? "pointer" : "";
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
  // 转录滚动:只有读者自己把视口向上移才释放尾部跟随;程序性 pin 在 settle 窗口内被折扣。
  elements.messages.addEventListener("scroll", () => {
    tailFollow.viewportChanged(elements.messages.scrollTop);
    syncActiveTurnToScroll();
  }, { passive: true });

  function autoResizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 160)}px`;
  }

  /// 钉到底部并发起一次 pin:settle 窗口内的 offset 移动是视图自己的,不计入释放判定。
  function scrollToBottom() {
    const scroller = elements.messages;
    scroller.scrollTop = scroller.scrollHeight;
    tailFollow.beginPin();
  }

  /// 跟随中每帧重钉;未跟随时什么都不做(读者在自由阅读)。
  function autoScroll() {
    if (tailFollow.isFollowing) scrollToBottom();
  }

  /// 一次 stop 若熬过静默窗口就被确认,跟随随之释放。
  function scheduleStopConfirm() {
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    if (!tailFollow.isStopPending) return;
    stopConfirmTimer = setTimeout(() => {
      stopConfirmTimer = null;
      tailFollow.confirmStop();
    }, STOP_CONFIRM_MS);
  }

  // toast 的隐藏是延时的:重复调用必须先撤掉上一次的定时器,否则旧 timer
  // 会把新 toast 提前关掉。
  let toastTimer = null;
  let toastLeaveTimer = null;

  /// 顶部 toast(antd message 风格)。type: error | success | info。
  function showToast(message, type = "error") {
    clearTimeout(toastTimer);
    clearTimeout(toastLeaveTimer);

    const icons = { error: "circle-alert", success: "check", info: "info" };
    const kind = icons[type] ? type : "error";
    const host = elements.toast;
    host.textContent = "";

    const card = document.createElement("div");
    card.className = "toast-card " + kind;
    card.setAttribute("role", kind === "error" ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(lucideIcon(icons[kind], { size: 14 }));

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
  /// draft:预填到新会话输入框的文字,打开后聚焦并把光标放在末尾(自动化页「新建」用)。
  async function newSession(options) {
    mainSurfaces?.close();
    settingsView?.close();
    historyDrawer?.hide?.();
    const { _retried = false, agentPreset = null, draft = "" } = (options && typeof options === "object" && !("target" in options))
      ? options : {};
    const workspace = workspaceMenu?.selected() ?? await prepareDefaultWorkspace();
    // agentPreset 只在"用创造模式创作"那条路径上传:宿主在 create 时就按它组装
    // agent,比先建再 select 少一次重建(select 是斜杠命令,会重启一次 agent)。
    const input = {
      ...(workspace?.workspaceId
        ? { workspaceId: workspace.workspaceId }
        : workspace?.path
          ? { cwd: workspace.path }
          : {}),
      ...(agentPreset ? { agentPreset } : {})
    };
    try {
      const sessionId = await deps.sessions.create(input);
      setDraft(sessionId, draft);
      const opened = await openSession(sessionId, { fresh: true, _retried });
      if (draft && opened === sessionId) {
        elements.input.focus();
        elements.input.setSelectionRange(draft.length, draft.length);
      }
      return sessionId;
    } catch (error) {
      // 该函数直接作为 click handler；错误若继续冒泡只会变成控制台里的
      // unhandled rejection，用户看起来像是按钮完全没反应。
      showToast(format(error));
      return null;
    }
  }

  /// 首次使用(没有任何工作区、会话、归档)时先让宿主建默认工作区并选中,首个会话
  /// 与首条消息就落在 <Documents>/deepseek-harness/<默认工作区> 里。必须在 session.create
  /// 之前:空白会话也算历史,建完再问宿主只会回无 value。失败只提示,照旧不带归属建会话
  ///(对齐 Mac 267bcde selectInitialSession;web 此时退回目录选择器)。
  async function prepareDefaultWorkspace() {
    if (!workspaceMenu || !deps.workspaces?.initializeDefault) return null;
    if (!isFirstUse({
      selected: workspaceMenu.selected(),
      workspaces: deps.workspaces.workspaces,
      sessions: deps.sessions.listStore?.get?.() ?? [],
      archivedSessionIds: deps.workspaces.archivedSessionIds
    })) return null;
    try {
      const workspace = await initializeDefaultWorkspace(deps.workspaces);
      if (!workspace) return null;
      await workspaceMenu.adopt(workspace);
      return workspace;
    } catch {
      showToast(t("workspace.defaultFailed"));
      return null;
    }
  }

  function isSessionUnopenable(error) {
    // 宿主错误码带命名空间(session/agent-busy …);子代理会话被直接打开时即回 session/agent-busy。
    return ["session/agent-busy", "session/not-found", "gateway/internal"].includes(error?.code);
  }

  // 会话打开竞态令牌:快速切换时迟到的历史加载不得覆盖新会话。
  let openSessionToken = 0;

  async function openSession(sessionId, { fresh = false, _retried = false } = {}) {
    mainSurfaces?.close();
    settingsView?.close();
    historyDrawer?.hide?.();
    const token = ++openSessionToken;
    // 离开当前会话前存草稿。
    setDraft(state.sessionId, elements.input.value);

    const previousSessionId = state.sessionId;
    state.sessionId = sessionId;
    // 附件没有像文字草稿那样按 sessionId 持久化。切换时若继续保留，会把上一
    // 会话选择的图片静默带到下一会话；读取中的占位也必须一并作废。
    if (previousSessionId !== sessionId) deps.attachments.clear();
    // 跟随属于被离开的内容:切会话即释放。
    tailFollow.release();
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    awaitingTurnStart = false;
    // 轨迹模式是一次点击的即时状态:打开任何会话都回到对话列。
    trajectory.close();
    chatRenderer.reset();
    historyLoadOlder.update(false);
    turnRail.reset();
    turnRailItems = [];
    activeTurn = null;
    busyTurn = null;
    // 切会话必须拆掉旧交互卡:它的 document 级键盘监听会一直活着。
    takeoverCard?.dispose?.();
    takeoverCard?.remove();
    takeoverCard = null;
    renderedTakeoverKey = null;
    elements.composerTakeover.replaceChildren();
    elements.composerTakeover.hidden = true;
    elements.composer.hidden = false;
    // 加载期间:隐藏「新会话」空态,改用等待动画 —— 否则聊天区先闪成一片空白,
    // 用户以为点错了会话。applySnapshot 完成后会用真实状态覆盖这个 typing。
    elements.emptyHint.hidden = true;
    chatRenderer.setTyping(true, t("sessions.loading"));
    // 上一个会话的运行状态不能挂到新会话上;新会话的快照到了会按真实状态重设。
    runningStatus.clear();
    historyDrawer?.setActive(sessionId, null);
    subagentCatalog.refresh();

    try {
      await deps.sessions.open(sessionId);
    } catch (error) {
      if (!_retried && isSessionUnopenable(error)) {
        showToast(format(error));
        return newSession({ _retried: true });
      }
      showToast(format(error));
      // service.open 失败时它仍停在之前的会话；UI 若继续保留目标 id，后续旧
      // 会话的实时帧会全部被 onRuntimeChange 丢弃，页面永久卡在空白加载态。
      if (token === openSessionToken) {
        state.sessionId = previousSessionId;
        // 没有可回退的会话时轨迹页无内容可看,直接收起。
        if (!previousSessionId) trajectory.close();
        const previousSnapshot = deps.sessions.getRuntimeSnapshot();
        if (previousSessionId && previousSnapshot?.sessionId === previousSessionId) {
          applySnapshot(previousSnapshot);
        } else {
          chatRenderer.setTyping(false);
          updateSendState();
        }
      }
      return null;
    }

    // 等待期间用户又切走了:迟到结果不得渲染到新会话上。
    if (token !== openSessionToken) return;

    // 会话切换是一次性操作,直接同步渲染,不等 onRuntimeChange 的 rAF 合并:
    // rAF 在侧栏不可见(visibilityState=hidden)时不会触发,renderScheduled 一旦卡在
    // true,后续 notifyRuntime 全被「if (renderScheduled) return」吞掉,聊天记录永远不渲染。
    // applySnapshot 内含 chatRenderer.render + emptyHint + setActive 等完整刷新。
    applySnapshot(deps.sessions.getRuntimeSnapshot());
    // 打开会话先落到底部;若该轮仍在跑,进入跟随(打开一个正在流式的会话就是想看它)。
    if (deps.sessions.getRuntimeSnapshot()?.running) tailFollow.didSubmit();
    scrollToBottom();

    void deps.sessions.refreshGoalActivation?.(sessionId);
    const summary = deps.sessions.listStore.get().find((item) => item.sessionId === sessionId);
    if (summary?.cwd) {
      state.cwd = summary.cwd;
      workspaceMenu?.setActiveByCwd(summary.cwd);
    }
    // 工作目录变了就是换了一个仓库(或换成一个非仓库),入口要跟着重判。
    refreshGitEntry();
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
      syncDocks(deps.sessions.getRuntimeSnapshot());
    });
    refreshSlashSources();
    return sessionId;
  }

  /// 打开一个子代理会话(只读)。对齐 Mac selectSubagent:走 subagent.history 读转录
  /// 而非 session.history;composer 只读由返回的 subagent 投影驱动(applySnapshot)。
  async function openSubagent(address) {
    const childId = address?.childSessionId;
    if (!childId || address?.mode === "external") return;
    mainSurfaces?.close();
    settingsView?.close();
    const token = ++openSessionToken;
    setDraft(state.sessionId, elements.input.value);

    const previousSessionId = state.sessionId;
    state.sessionId = childId;
    if (previousSessionId !== childId) deps.attachments.clear();
    tailFollow.release();
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = null;
    awaitingTurnStart = false;
    trajectory.close();
    chatRenderer.reset();
    historyLoadOlder.update(false);
    takeoverCard?.dispose?.();
    takeoverCard?.remove();
    takeoverCard = null;
    renderedTakeoverKey = null;
    elements.composerTakeover.replaceChildren();
    elements.composerTakeover.hidden = true;
    elements.composer.hidden = false;
    elements.emptyHint.hidden = true;
    chatRenderer.setTyping(true, t("sessions.loading"));
    runningStatus.clear();
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

    applySnapshot(deps.sessions.getRuntimeSnapshot());
    scrollToBottom();
    subagentCatalog.refresh();

    const summary = deps.sessions.listStore.get().find((item) => item.sessionId === childId);
    if (summary?.cwd) {
      state.cwd = summary.cwd;
      workspaceMenu?.setActiveByCwd(summary.cwd);
    }
    // 工作目录变了就是换了一个仓库(或换成一个非仓库),入口要跟着重判。
    refreshGitEntry();
    picker.clear();
    renderPickedChip();
    setInputText("");
    autoResizeInput();
    updateSendState();

    dock.refreshModelMenu();
    dock.refreshPresetMenu().then(() => {
      syncDocks(deps.sessions.getRuntimeSnapshot());
    });
    refreshSlashSources();
  }

  // ---- 全局快捷键 ----
  // 命令表声明键位,这里把命令 id 落到动作上。返回值语义:true=已处理;
  // false=当前不可用,别消费这个键(让 Escape 之类继续去做它本来的事)。
  function showPopover(menu) {
    if (!menu || typeof menu.showPopover !== "function") return false;
    try {
      if (!menu.matches(":popover-open")) menu.showPopover();
      return true;
    } catch { return false; }
  }
  function togglePopover(menu) {
    if (!menu || typeof menu.showPopover !== "function") return false;
    try {
      if (menu.matches(":popover-open")) menu.hidePopover();
      else menu.showPopover();
      return true;
    } catch { return false; }
  }
  /// 上一个/下一个会话走的是**会话列表当前画出来的那个顺序**(置顶区在前,
  /// 然后按当前分组/排序档),这样 ⌘[ / ⌘] 与眼睛看到的列表永远一致。
  /// 抽屉还没画过(冷启动、从没打开过)时回落到整册名册,过滤规则与列表相同。
  function sidebarOrderIds() {
    const rendered = historyDrawer?.renderedOrder?.() ?? [];
    if (rendered.length) return rendered;
    return visibleSessions(deps.sessions.listStore.get(), {
      archivedIds: deps.sessions?.archivedSessionIds?.() ?? deps.workspaces?.archivedSessionIds ?? [],
      activeSessionId: state.sessionId
    }).map((item) => item.sessionId);
  }
  function stepSession(delta) {
    const list = sidebarOrderIds();
    if (!list.length) return false;
    const idx = list.indexOf(state.sessionId);
    const next = idx === -1 ? (delta > 0 ? 0 : list.length - 1)
      : (idx + delta + list.length) % list.length;
    const target = list[next];
    if (!target || target === state.sessionId) return false;
    void openSession(target).catch((error) => showToast(format(error)));
    return true;
  }
  function clearDraftShortcut() {
    if (elements.composer.hidden) return false;
    if (!elements.input.value && !occurrences.length) return false;
    setInputText("");
    autoResizeInput();
    updateSendState();
    setDraft(state.sessionId, "");
    elements.input.focus();
    return true;
  }
  function removeLastAttachmentShortcut() {
    const list = deps.attachments.visible ?? deps.attachments.all ?? deps.attachments.pending ?? [];
    if (!list.length) return false;
    deps.attachments.remove(list.length - 1);
    return true;
  }
  function lastResponseText() {
    const nodes = deps.sessions.getRuntimeSnapshot?.()?.nodes ?? [];
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (node?.kind !== "assistant") continue;
      const text = (node.blocks ?? [])
        .filter((b) => b && b.type === "text" && b.text)
        .map((b) => b.text).join("\n\n").trim();
      if (text) return text;
    }
    return "";
  }
  function stepModel(delta) {
    const current = state.currentModel;
    const entries = state.models ?? [];
    if (!state.sessionId || !current || !entries.length) return false;
    const idx = entries.findIndex((m) => m.provider === current.provider && m.model === current.model);
    const base = idx === -1 ? (delta > 0 ? -1 : entries.length) : idx;
    const entry = entries[Math.min(entries.length - 1, Math.max(0, base + delta))];
    if (!entry || (entry.provider === current.provider && entry.model === current.model)) return false;
    state.currentModel = { provider: entry.provider, model: entry.model };
    if (elements.modelLabel) elements.modelLabel.textContent = entry.label;
    void deps.sessions.selectModel(state.sessionId, entry.provider, entry.model)
      .catch((error) => showToast(format(error)));
    return true;
  }
  function stepEffort(delta) {
    if (!state.sessionId || !state.currentModel) return false;
    const sessionId = state.sessionId;
    const current = { ...state.currentModel };
    void (async () => {
      const sessionModels = await deps.sessions.models(sessionId);
      if (state.sessionId !== sessionId) return;
      const efforts = (sessionModels.reasoningEfforts ?? sessionModels.current?.reasoningEfforts ?? [])
        .map((e) => (typeof e === "string" ? e : e?.id)).filter(Boolean);
      if (efforts.length < 2) return;
      const cur = state.currentReasoningEffort ?? sessionModels.current?.reasoningEffort ?? null;
      const at = cur == null ? -1 : efforts.indexOf(cur);
      const base = at === -1 ? (delta > 0 ? -1 : efforts.length) : at;
      const next = efforts[Math.min(efforts.length - 1, Math.max(0, base + delta))];
      if (!next || next === cur) return;
      state.currentReasoningEffort = next;
      await deps.sessions.selectModel(sessionId, current.provider, current.model, next);
      void dock.refreshModelMenu();
    })().catch((error) => showToast(format(error)));
    return true;
  }
  async function applyPermission(value) {
    if (!state.sessionId) return;
    if (isFullAccessOption(value) && !(await dock.confirmFullAccess())) return;
    try {
      const execution = await deps.commands.execute(state.sessionId, `/permission ${value}`);
      if (execution?.result?.kind === "error") showToast(execution.result.text || t("command.failed"));
    } catch (error) { showToast(format(error)); }
  }
  function togglePageContextShortcut() {
    if (!state.sessionId) return false;
    const label = t("pageCtx.current");
    const draft = elements.input.value;
    const existing = occurrences.find((o) => o.label === label);
    if (existing) {
      const removeStart = existing.offset;
      const removeEnd = existing.offset + existing.length;
      let end = removeEnd;
      if (draft[end] === " ") end += 1;
      const removed = end - removeStart;
      const text = draft.slice(0, removeStart) + draft.slice(end);
      const next = occurrences
        .filter((o) => o !== existing)
        .map((o) => (o.offset >= removeEnd ? { ...o, offset: o.offset - removed } : o));
      setInputText(text, next);
      autoResizeInput();
      updateSendState();
      setDraft(state.sessionId, text);
      return true;
    }
    if (elements.composer.hidden) return false;
    const caret = elements.input.selectionStart ?? draft.length;
    void (async () => {
      const capture = await pageContext.captureCurrentTab();
      const text = formatPageContext(capture);
      if (!text) { showToast(t("pageCtx.unavailable")); return; }
      const next = insertReference(elements.input.value, occurrences, { start: caret, end: caret }, { label, text });
      setInputText(next.text, next.occurrences);
      elements.input.focus();
      elements.input.setSelectionRange(next.caret, next.caret);
      autoResizeInput();
      updateSendState();
      setDraft(state.sessionId, next.text);
    })();
    return true;
  }
  function forkSessionShortcut() {
    if (!state.sessionId) return false;
    const sessionId = state.sessionId;
    void (async () => {
      try { await openSession(await deps.sessions.fork(sessionId)); }
      catch (error) { showToast(format(error)); }
    })();
    return true;
  }
  function renameSessionShortcut() {
    if (!state.sessionId) return false;
    // 与双击顶栏标题同一个行内编辑框;抽屉未挂载时(理论上不会)退回 prompt。
    if (historyDrawer?.editTitle) return historyDrawer.editTitle();
    const name = window.prompt(t("session.renamePrompt"));
    if (name && name.trim()) {
      void deps.sessions.rename(state.sessionId, name).catch((error) => showToast(format(error)));
    }
    return true;
  }
  function archiveSessionShortcut() {
    if (!state.sessionId) return false;
    const sessionId = state.sessionId;
    void (async () => {
      try {
        const archived = await deps.sessions.archive(sessionId, {
          confirmStop: () => Promise.resolve(window.confirm(t("session.archiveActiveConfirm")))
        });
        if (archived === null) return;
        await deps.sessions.refreshList().catch(() => {});
        // 接替谁:与列表同一个顺序里的下一行(与 ⌘[ / ⌘] 同源)。
        const rest = sidebarOrderIds().filter((id) => id !== sessionId);
        if (rest.length) await openSession(rest[0]);
        else await newSession();
      } catch (error) { showToast(format(error)); }
    })();
    return true;
  }
  function copyLastResponseShortcut() {
    const text = lastResponseText();
    if (!text) return false;
    const pending = navigator.clipboard?.writeText(text);
    if (pending?.then) pending.then(() => showToast(t("copied"))).catch(() => {});
    else showToast(t("copied"));
    return true;
  }
  function goalTogglePauseShortcut() {
    const goal = activeGoal(currentGoal());
    if (!goal || !state.sessionId) return false;
    const action = goal.phase === "paused" || (goal.phase === "active" && goal.activation === "disarmed")
      ? deps.goals.resume : deps.goals.pause;
    void Promise.resolve(action(state.sessionId, goal)).catch((error) => showToast(format(error)));
    return true;
  }
  function goalClearShortcut() {
    const goal = activeGoal(currentGoal());
    if (!goal || !state.sessionId) return false;
    void Promise.resolve(deps.goals.clear(state.sessionId, goal)).catch((error) => showToast(format(error)));
    return true;
  }
  function goalNewShortcut() {
    if (!state.sessionId) return false;
    const objective = window.prompt(t("goal.objective"));
    if (objective && objective.trim()) {
      void Promise.resolve(deps.goals.create(state.sessionId, objective.trim()))
        .catch((error) => showToast(format(error)));
    }
    return true;
  }
  function shortcutHandlers() {
    return {
      findInSession: () => {
        if (!historyDrawer) return false;
        historyDrawer.show();
        return true;
      },
      previousSession: () => stepSession(-1),
      nextSession: () => stepSession(1),
      renameSession: renameSessionShortcut,
      forkSession: forkSessionShortcut,
      archiveSession: archiveSessionShortcut,
      copyLastResponse: copyLastResponseShortcut,
      stopGenerating: () => {
        if (!state.running) return false;
        void stopRun();
        return true;
      },
      focusComposer: () => {
        if (elements.composer.hidden || elements.input.disabled) return false;
        elements.input.focus();
        return true;
      },
      clearDraft: clearDraftShortcut,
      removeLastAttachment: removeLastAttachmentShortcut,
      choosePermission: () => (elements.permBtn.hidden ? false : showPopover(elements.permMenu)),
      permissionReadOnly: () => {
        if (!state.sessionId) return false;
        void applyPermission("read-only");
        return true;
      },
      permissionWorkspaceWrite: () => {
        if (!state.sessionId) return false;
        void applyPermission("workspace-write");
        return true;
      },
      permissionFullAccess: () => {
        if (!state.sessionId) return false;
        void applyPermission("danger-full-access");
        return true;
      },
      chooseModel: () => (elements.modelBtn.hidden ? false : showPopover(elements.modelMenu)),
      previousModel: () => stepModel(-1),
      nextModel: () => stepModel(1),
      increaseEffort: () => stepEffort(1),
      decreaseEffort: () => stepEffort(-1),
      chooseAgentPreset: () => (elements.presetBtn.hidden ? false : showPopover(elements.presetMenu)),
      exitPlanMode: () => {
        if (!state.sessionId) return false;
        if (deps.sessions.getRuntimeSnapshot?.()?.planMode !== true) return false;
        void dock.exitPlanMode();
        return true;
      },
      showSubagents: () => (elements.subagentCatalogBtn.hidden ? false : togglePopover(elements.subagentCatalogMenu)),
      contextUsage: () => (elements.statsBtn.hidden ? false : showPopover(elements.statsMenu)),
      compactContext: () => {
        if (!state.sessionId) return false;
        void deps.commands.execute(state.sessionId, "/compact").catch((error) => showToast(format(error)));
        return true;
      },
      newGoal: goalNewShortcut,
      editGoal: () => goalBar.edit(),
      toggleGoalPause: goalTogglePauseShortcut,
      clearGoal: goalClearShortcut,
      toggleTodoPanel: () => todoPanel.toggle(),
      openSettings: () => (settingsView ? (settingsView.show(), true) : false),
      keyboardShortcuts: () => (settingsView ? (settingsView.show("shortcuts"), true) : false),
      togglePageContext: togglePageContextShortcut
    };
  }

  // ---- 快捷键 ----
  function setupShortcuts() {
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const shortcutLabels = getSessionShortcutLabels(platform);
    elements.shortcutNew.textContent = shortcutLabels.newSession;
    elements.shortcutHistory.textContent = shortcutLabels.history;
    elements.hdrNew.title = `${t("new_session")} (${shortcutLabels.newSession})`;
    elements.hdrTitleWrap.title = `${t("history")} (${shortcutLabels.history})`;
    elements.hdrTitleWrap.setAttribute("aria-label", t("history.label"));
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
    // 命令表其余命令的统一分派(见 shortcut-bindings.js)。bubble 阶段注册在
    // 上面的就地处理器之后:它们已经 preventDefault/stopPropagation 的键到不了这里。
    const dispatcher = createShortcutDispatcher({
      platform,
      handlers: shortcutHandlers(),
      isSettingsOpen: () => Boolean(elements.viewSettings?.getClientRects().length)
    });
    document.addEventListener("keydown", dispatcher.handleKeyDown);
    return shortcutLabels;
  }

  // ---- 启动 ----
  /// 语言切换后重画:静态 DOM、底栏、设置页与当前快照都要按新语言重渲染。
  function relabel() {
    applyStaticLabels(root);
    elements.input.placeholder = t("input.placeholder");
    updateSendState();
    renderPickerButton();
    renderPickedChip();
    settingsView?.relabel();
    mainSurfaces?.relabel();
    const newLabel = document.querySelector("#history-new-btn [data-navigation-label]");
    if (newLabel) newLabel.textContent = t("new_session");
    const settingsLabel = document.querySelector("#history-settings-btn [data-navigation-label]");
    if (settingsLabel) settingsLabel.textContent = t("settings");
    trajectory.relabel();
    const snapshot = deps.sessions.getRuntimeSnapshot();
    if (snapshot) {
      applySnapshot(snapshot);
      syncDocks(snapshot);
    }
    dock.refreshModelMenu();
    void dock.refreshPresetMenu();
    historyDrawer?.relabel?.();
    historyDrawer?.refresh?.();
    setupGuide?.relabel();
    apiKeyOnboarding?.relabel();
  }

  // ---- 首次使用引导 ----
  /// 本机没装好 dsh / dsh-chrome-control(或启动器坏了)时,用安装引导替代那句
  /// "Specified native messaging host not found." toast。引导自己轮询只读的
  /// probe,一旦检测到就收起并重新走一遍 startConnection。
  function showSetupGuide(error) {
    const host = document.querySelector("#setup-guide");
    if (!host) return false;
    setupGuide ||= mountSetupGuide(host, {
      probe: deps.probeNativeHost ?? probeHost,
      onReady: async () => {
        hideSetupGuide();
        setStreamState(deps.DshStreamState.CONNECTING);
        await startConnection();
      }
    });
    document.body.classList.add("setup-required");
    void setupGuide.show(error.issue, error.detail);
    return true;
  }

  function hideSetupGuide() {
    setupGuide?.hide();
    document.body.classList.remove("setup-required");
  }

  async function start() {
    setStreamState(deps.DshStreamState.CONNECTING);
    // 先用本地镜像定色:宿主的 ui-theme.preference 要等连接之后才知道,
    // 而用户上次的选择不该在冷启动时被系统色盖掉一帧。
    deps.settings.getThemePreference?.()
      .then((preference) => theme?.setPreference(preference))
      .catch(() => { /* 读不到就保持跟随系统 */ });
    applyStaticLabels(root);
    elements.input.placeholder = t("input.placeholder");
    updateSendState(false);
    const shortcutLabels = setupShortcuts();
    renderPickerButton();
    renderPickedChip();
    workspaceMenu = mountWorkspaceMenu(elements, deps, {
      showToast,
      hostCwd: () => state.hostCwd,
      // 临时会话落在用户 home:工作目录标签显示 Home,而不是用户名或整条 C:\Users\<name>。
      hostHome: () => state.hostHome ?? deps.sessions?.hostHome ?? null,
      // 换工作目录:历史列表换过滤范围;新建会话页上它还决定"下一条消息发去哪",
      // 所以 Git 入口也要跟着重判 —— 否则头部会一边写着新目录名,一边显示上一个
      // 仓库的分支。
      onChange: () => {
        // 会话列表不再按目录过滤(分组取代了它),所以这里只是顺手刷新一下名册,
        // 不再整块转圈重拉 —— 换目录改变的只是"下一个会话建在哪"。
        historyDrawer?.refresh();
        refreshGitEntry();
      }
    });
    // 宿主置顶写失败时(已回滚)给个提示,否则用户只会看到图钉"弹回去"。
    deps.pinnedStore?.setErrorHandler?.(() => showToast(t("session.pinFailed")));
    historyDrawer = mountHistoryDrawer(deps, openSession, newSession, shortcutLabels, {
      // 抽屉按工作区分组(对齐 Mac 左侧栏),所以它要的是整份 workspace 名单
      // 与归档名单,而不再是"当前选中目录"那一个过滤条件。
      workspaces: () => deps.workspaces?.workspaces ?? [],
      // 归档集合以会话服务为准:它在归档 / 取消归档回包时立即结算,而 workspace
      // 服务要等 follow 帧 —— 刚取消归档的行不该在列表里多藏一拍。
      archivedIds: () => deps.sessions?.archivedSessionIds?.() ?? deps.workspaces?.archivedSessionIds ?? [],
      orderStore: deps.sessions?.orderStore ?? null,
      pinnedStore: deps.pinnedStore ?? null,
      // 分区标题右侧的「添加目录」:与工作目录菜单里的那一项同一条路径。
      onAddWorkspace: () => workspaceMenu?.addDirectory?.(),
      showToast
    });
    // 设置页需要 showToast 报告写失败,而 deps 是纯组装层拿不到它 —— 就地补一个。
    settingsView = mountSettings(
      // 语言切换要重画整个界面(静态标签 + 各 pane),所以把 app 的 relabel 交给设置页。
      {
        ...deps, showToast, onBusyEnterChange: setBusyEnter, onLanguageChange: relabel, theme,
        // full-access 的确认框由通用分页与 composer 共用同一个 <dialog>;
        // composer-dock 自己拿的是 elements.permConfirm,这里补一份给设置页。
        permConfirm: elements.permConfirm
      },
      {
        // 设置页改完提供方/模型目录后,当场重画底栏模型菜单 ——
        // 用户关掉设置页就能在对话框里看到新模型,不必切会话。
        onModelsChanged: () => { dock.refreshModelMenu(); },
        onVisibilityChanged: (visible) => {
          mainSurfaces?.setSuspended(visible);
          if (visible) historyDrawer?.hide?.();
        },
        // 预设页的"用创造模式创作":新建一个跑创造模式预设的会话,然后关掉设置页
        // —— 这个手势结束在对话里,不在设置页(web D43)。新建失败时把错误抛回
        // 预设页,由它就地显示,不要静默留用户站在一个什么都没发生的按钮前面。
        onStartCreatorDraft: async (agentPreset) => {
          const sessionId = await newSession({ agentPreset });
          if (sessionId) settingsView?.close();
          return sessionId;
        }
      }
    );
    // 首次使用第二步:连上 dsh 后若没有任何可用的模型提供方,弹 API Key 引导
    // (Mac DeepSeekOnboardingDialog)。判定在 startConnection 里每次连上后跑一次。
    apiKeyOnboarding = createApiKeyOnboarding({
      dialog: document.querySelector("#key-onboarding"),
      settingsService: createSettingsService(deps.connection),
      formatError: format,
      onConfigureOther: () => settingsView?.show("models"),
      // 存好 key 后模型目录才有内容:刷新全局目录并重画底栏模型菜单,
      // 用户关掉弹窗就能直接发第一条消息。
      onSaved: () => {
        deps.models.refresh().catch(() => {}).finally(() => dock.refreshModelMenu());
      }
    });
    mainSurfaces = mountMainSurfaces(document, {
      beforeOpen: () => { historyDrawer?.hide?.(); settingsView?.close(); trajectory.close(); findBar.close(); },
      onClose: ({ restoreFocus }) => { if (restoreFocus) elements.input.focus(); },
      onError: (error) => showToast(format(error)),
      pages: {
        plugins: { titleKey: "management.plugins", mount: (host) => settingsView.createPluginManager(host) },
        automations: { titleKey: "management.automations", mount: (host) => mountAutomationsPage(host, {
          service: deps.automations, sessions: deps.sessions, workspaces: deps.workspaces, showToast,
          onNewSession: () => newSession({ agentPreset: "cordis", draft: t("automationsNewDraft") }), onOpenSession: openSession
        }) }
      }
    });
    // The archive view appends its footer during mount; Settings remains last.
    document.querySelector("#session-drawer").append(document.querySelector("#history-settings-btn"));
    const navigationIcons = { plugins: "puzzle", automations: "clock" };
    for (const button of document.querySelectorAll("[data-main-surface]")) {
      button.insertAdjacentHTML("afterbegin", lucideIconSvg(navigationIcons[button.dataset.mainSurface], { size: 15 }));
    }
    document.querySelector("#history-new-btn").insertAdjacentHTML("afterbegin", lucideIconSvg("plus", { size: 15 }));
    document.querySelector("#history-settings-btn").insertAdjacentHTML("afterbegin", lucideIconSvg("settings", { size: 15 }));
    document.querySelector("#history-new-btn").addEventListener("click", () => { void newSession(); });
    document.querySelector("#history-settings-btn").addEventListener("click", () => settingsView.show());
    relabel();
    document.defaultView?.addEventListener("unload", () => {
      mainSurfaces?.dispose(); settingsView?.dispose(); deps.automations?.dispose();
    }, { once: true });
    startConnection();
    // 通知点击(侧栏已开着):worker 写入 pending sessionId,这里即时切会话。
    // 启动那次的领取在 startConnection 里,要等会话列表就绪。
    deps.pendingSessionOpen?.subscribe?.((sessionId) => {
      openSession(sessionId).catch((error) => showToast(format(error)));
    });
    // 工具栏圆点:报告「正看着哪条会话」,并把 SW 的未读镜像到会话行上。
    deps.taskUnreadMirror?.start?.();
    deps.presence?.start?.();
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
      const path = pendingWorkspacePath() ?? executionDirectory() ?? workspaceMenu?.displayedPath();
      if (!path) return;   // 连接前的极短窗口:尚无任何目录
      try {
        await deps.workspaces.openPath(path);
      } catch (error) {
        showToast(format(error));
      }
    });
  }

  /// 属于当前选中工作目录的会话(顺序沿用 listStore 的最近优先)。
  /// 「全部」时返回全部;选中具体 workspace 时以宿主的 sessionIds 名单为准,
  /// 名单缺失才回落 cwd 比对 —— 与 historyDrawer 的过滤口径一致。
  function sessionsInActiveWorkspace(listed) {
    // 名单为空数组有两种含义:宿主真的说"这个 workspace 没有会话",或宿主压根
    // 没给 sessionIds。两者都不该直接判定为空 —— 空名单时回落 cwd 比对更安全:
    // 真没有会话时 cwd 过滤同样为空,不会误恢复别的目录的会话。
    const ids = workspaceMenu?.activeSessionIds() ?? null;
    if (ids && ids.length) {
      const allow = new Set(ids);
      return listed.filter((item) => allow.has(item.sessionId));
    }
    const path = workspaceMenu?.activePath() ?? null;
    if (!path) return listed;
    return listed.filter((item) => item.cwd === path);
  }

  async function startConnection() {
    try {
      await deps.connection.ensureStarted();
      setStreamState(deps.connection.streamState);
      // `$events` ready 提供 home,工具行用它把残留的绝对路径缩写成 ~;
      // cwd 则是「临时目录」过滤项的路径。这一步在下面的 workspaceMenu.refresh()
      // 之前完成,所以菜单首次渲染就能拿到 hostCwd,不需要补渲。
      state.hostHome = deps.sessions.hostHome ?? null;
      state.hostCwd = null;
    } catch (error) {
      // 本机还没装好 DSH:后面的列表/模型/会话全都会因同一原因失败,
      // 展示安装引导并就此打住,装好后由引导重新调用 startConnection。
      if (isNativeHostSetupError(error) && showSetupGuide(error)) {
        setStreamState(deps.DshStreamState.DISCONNECTED);
        return;
      }
      showToast(format(error));
    }
    hideSetupGuide();
    await Promise.allSettled([
      deps.sessions.refreshList(),
      workspaceMenu ? workspaceMenu.refresh() : deps.workspaces.refresh(),
      deps.models.refresh(),
      loadBusyEnter()
    ]);
    // 不阻塞会话恢复:判定要读提供方/设置/凭证三份事实,读完才决定弹不弹。
    void apiKeyOnboarding?.evaluate();
    const listed = deps.sessions.listStore.get();
    // 通知点击把侧栏拉起来的场景:优先打开通知指向的会话,盖过默认恢复。
    // 只认列表里存在的 id —— 会话可能在点击与启动之间被删掉。
    const pendingId = await deps.pendingSessionOpen?.take?.().catch(() => null) ?? null;
    if (pendingId && listed.some((item) => item.sessionId === pendingId)) {
      await openSession(pendingId);
      return;
    }
    // 启动时恢复哪个会话,必须服从当前选中的工作目录 —— 否则 listed[0](全局最近)
    // 可能属于别的目录,'@' 的文件候选走 fileReferences/list 只认会话 cwd,
    // 用户就会在项目目录下看到家目录的 Applications/ Desktop/ ...
    // 过滤规则与历史列表保持一致:优先宿主给的成员名单,回落按 cwd 比对。
    const restorable = sessionsInActiveWorkspace(listed);
    if (restorable.length) await openSession(restorable[0].sessionId);
    else if (workspaceMenu?.activePath() || workspaceMenu?.activeSessionIds()) await newSession();
    else if (listed.length) await openSession(listed[0].sessionId);
    else await newSession();
  }

  return Object.freeze({ start, openSession, newSession, sendMessage, stopRun, relabel, state });
}
