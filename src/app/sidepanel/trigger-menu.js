// "/" 与 "@" 触发候选菜单的 DOM 层。状态机在 composer-triggers.js。
//
// 来源:"/" → commands + skills(本地已缓存,同步结算);
//       "@" → 固定行(当前网页 / 添加图片)+ 文件路径(host.listDirectory,异步)
//             + 已知 subagent 会话。
//
// 底栏的 ＋ 按钮打开的**就是这一个**浮层(见 openAtCaret):它与输入 "@" 唯一的
// 区别是没有触发词可删,合成一个空 span 的 hit 即可,其余渲染/选中/键盘路径完全共用。
import { t } from "../../shared/i18n.js";
import { formatPageContext } from "../../features/page-context/page-context-format.js";
import { ACTION_SOURCES, isActionSource, actionCandidates } from "./trigger-actions.js";
import { dropTriggerText, insertChip, insertPlain } from "./trigger-insert.js";
import {
  detectTrigger, filterByFuzzy, createMenuState, menuOnHit, menuOnSettled,
  menuOnFailed, menuMove, menuHighlightedItem, menuClose
} from "./composer-triggers.js";

const SLASH_SOURCES = ["commands", "skills"];

/**
 * extraSources:'@' 浮层的可插拔异步候选来源(这里只认契约):
 *   { source: string, label: string, candidates(query) => Promise<candidate[]> }
 * 排在固定行(当前网页/添加图片)之后、文件引用之前。候选可带 resolveText():
 * 选中那一刻才异步解析出胶囊要展开的完整文本(列表阶段只有轻量摘要)。
 */
export function mountTriggerMenu({
  elements, deps, state, onInsertReference, getOccurrences,
  captureCurrentTab, onAttachImage, showToast = () => {}, extraSources = []
}) {
  let menu = createMenuState();
  const extraBySource = new Map(extraSources.map((s) => [s.source, s]));
  // 对齐 Mac 的 '@' 来源集合,前面接上固定行(当前网页 / 添加图片,见 trigger-actions)。
  const atSources = [
    ...ACTION_SOURCES, ...extraSources.map((s) => s.source),
    "reference-file", "reference-session", "subagent"
  ];

  function close() {
    menu = menuClose(menu);
    elements.triggerMenu.hidden = true;
    elements.triggerMenu.replaceChildren();
    elements.attachBtn?.setAttribute("aria-expanded", "false");
  }

  function sectionLabel(source) {
    const extra = extraBySource.get(source);
    if (extra) return extra.label;
    if (source === "commands") return t("menu.commands");
    if (source === "skills") return t("skills.title");
    if (isActionSource(source)) return t("trigger.context");
    if (source === "reference-file") return t("reference.file");
    if (source === "reference-session") return t("reference.session");
    if (source === "subagent") return t("subagent.title");
    return t("workspace.title");
  }

  function render() {
    if (!menu.open) { close(); return; }
    const container = elements.triggerMenu;
    container.replaceChildren();
    let rows = 0;
    let highlightedRow = null;
    // 固定行(page/attach)共用一个分组标题:它们同属"上下文"而非两个来源,
    // 各自单独挂一行标题会让浮层顶部堆两条几乎一样的小字。
    let contextLabelDrawn = false;
    for (const group of menu.groups) {
      if (group.status === "pending") {
        // 异步来源:先占位,避免菜单在等待期间闪烁成空。
        if (group.source.startsWith("reference-") || extraBySource.has(group.source)) {
          const pending = document.createElement("div");
          pending.className = "trigger-pending";
          pending.textContent = "…";
          container.append(pending);
        }
        continue;
      }
      if (!group.items.length) continue;
      const isContext = isActionSource(group.source);
      if (!isContext || !contextLabelDrawn) {
        const label = document.createElement("div");
        label.className = "trigger-group-label";
        label.textContent = sectionLabel(group.source);
        container.append(label);
        if (isContext) contextLabelDrawn = true;
      }
      group.items.forEach((item, index) => {
        rows += 1;
        const row = document.createElement("div");
        row.className = "trigger-item";
        row.setAttribute("role", "option");
        if (menu.highlight?.source === group.source && menu.highlight.index === index) {
          row.classList.add("highlighted");
          highlightedRow = row;
        }
        // 行最左的类型标识(如 wiki 候选的「会议/日报」),由候选自带,通用渲染。
        if (item.badge) {
          const badge = document.createElement("span");
          badge.className = "trigger-item-badge";
          badge.textContent = item.badge;
          row.append(badge);
        }
        const name = document.createElement("span");
        name.className = "trigger-item-name";
        // '@' 引用候选自带展示名(如「文件 · chat-view.js」),固定行也是现成的
        // 人类可读标题,两者都不加触发符前缀;只有命令/技能才拼上 '/'。
        name.textContent = (item.action || item.value || item.resolveText) ? item.name : `${menu.hit.trigger}${item.name}`;
        row.append(name);
        if (item.description) {
          const hint = document.createElement("span");
          hint.className = "trigger-item-hint";
          hint.textContent = item.description;
          row.append(hint);
        }
        // mousedown 而非 click:click 之前 textarea 会先失焦,插入位置就丢了。
        row.addEventListener("mousedown", (event) => { event.preventDefault(); void pick(item); });
        container.append(row);
      });
    }
    if (!rows && !menu.groups.some((g) => g.status === "pending")) { close(); return; }
    container.hidden = false;
    elements.attachBtn?.setAttribute("aria-expanded", "true");
    // 菜单高度封顶(18rem)且可滚动:方向键把高亮移出可视区时列表必须跟着滚,
    // 否则用户看到的是"上下键没反应"——高亮其实在视口外移动。
    // 必须在 hidden = false 之后:隐藏元素没有布局,scrollIntoView 是空操作。
    // jsdom 等无布局环境没有这个方法,可选调用即可(那里也无所谓滚动)。
    highlightedRow?.scrollIntoView?.({ block: "nearest" });
  }

  const chip = (reference) =>
    insertChip(elements.input, menu.hit, getOccurrences?.() ?? [], reference, onInsertReference);

  /// 「当前网页」:选中的**这一刻**就把 tabId 解析成最终文本存进胶囊 ——
  /// 此时用户正看着那个标签页,语义最准;之后即使切了页,这条引用也不会漂移。
  async function pickCurrentPage() {
    const capture = await captureCurrentTab?.();
    const text = formatPageContext(capture);
    if (!text) {
      // 取不到 tab 只是"没有网页可引用",不该把用户打的字也吃掉之外再做别的。
      showToast(t("pageCtx.unavailable"));
      dropTriggerText(elements.input, menu.hit);
      close();
      return;
    }
    chip({ label: t("pageCtx.current"), text });
    close();
  }

  async function pick(candidate) {
    if (!menu.hit) return;
    // 固定行:不插引用文本,只执行一个动作。必须排在胶囊/裸文本两条路之前。
    if (candidate.action === "page") return pickCurrentPage();
    if (candidate.action === "attach-image") {
      dropTriggerText(elements.input, menu.hit);
      close();
      onAttachImage?.();
      return;
    }
    // 异步解析型候选:与「当前网页」同理,选中的这一刻
    // 才把候选解析成最终文本存进胶囊。解析失败不能悄悄插一枚空胶囊 —— toast 之后
    // 把触发词抹掉,与 pickCurrentPage 的失败路径一致。
    if (typeof candidate.resolveText === "function") {
      const label = candidate.insertLabel ?? candidate.name;
      let text = null;
      try { text = await candidate.resolveText(); } catch { /* 统一走下面的失败路径 */ }
      if (!menu.hit) return; // 等待期间菜单已被关闭/换代
      if (!text) {
        showToast(t("trigger.resolveFailed"));
        dropTriggerText(elements.input, menu.hit);
        close();
        return;
      }
      if (onInsertReference) chip({ label, text });
      else insertPlain(elements.input, menu.hit, { value: text });
      close();
      return;
    }
    // 选中即插成胶囊:草稿里只留一个占位符,完整文本存进 occurrence,
    // 由镜像层画成 Mac 那样的圆角标签。'/' 命令与技能同样走胶囊 ——
    // 发送时 projectDraft() 会把它展开回 "/name ",tryDispatchCommand 的
    // ^/(\S+) 匹配拿到的是展开后的文本,命令照常执行。
    //
    // 唯一例外是目录下钻(insertsPlainText):那种候选要留成可继续编辑的
    // 裸路径,插成胶囊就没法再往下一级走了。
    const asChip = Boolean(onInsertReference && !candidate.insertsPlainText);
    if (asChip) {
      // '@' 候选自带格式化好的 value(含引号/前缀);'/' 候选只有 name,
      // 要在这里补上触发符,与 applyPick 的拼法保持一致。
      const text = candidate.value ?? `${menu.hit.trigger}${candidate.name}`;
      // 胶囊上显示什么:'@' 引用用短名(insertLabel,如 "theme.js");
      // '/' 命令/技能连触发符一起显示("/compact"),与菜单里那一行一致。
      const label = candidate.insertLabel ?? (candidate.value ? candidate.name : text);
      chip({ label, text });
      close();
      return;
    }
    // keepOpen(目录下钻)时不关:insertPlain 派发的 input 事件会重新检测触发并降一级。
    if (!insertPlain(elements.input, menu.hit, candidate)) close();
  }

  /// 同步来源:命令与技能已在本地缓存,固定行是写死的两条。
  function localCandidates(source, query) {
    if (isActionSource(source)) {
      return actionCandidates(source, query, {
        canCapturePage: Boolean(captureCurrentTab),
        canAttachImage: Boolean(onAttachImage)
      });
    }
    if (source === "commands") {
      return filterByFuzzy(deps.commands.commands ?? [], query).map((c) => ({
        name: c.name, description: c.description
      }));
    }
    if (source === "skills") {
      // 与命令同一套模糊打分:纯前缀过滤下 "/jira" 找不到 "to-jira-guild"。
      return filterByFuzzy(deps.skills.skills ?? [], query).map((s) => ({
        name: s.name, description: s.description
      }));
    }
    if (source === "subagent") {
      // 运行中的直接子会话,按标题包含匹配(空查询匹配全部)。
      const parentId = state.sessionId;
      return (deps.sessions.listStore.get() ?? [])
        .filter((s) => s.parentSessionId === parentId && s.running)
        .map((s) => ({ name: s.projections?.values?.title ?? s.sessionId }))
        .filter((c) => !query || c.name.includes(query))
        .map((c) => ({ ...c, value: `@${c.name}` }));
    }
    return [];
  }

  /// 查询词里的引号是 @"path with spaces" 语法的开引号,要先剥掉再送给宿主。
  function referenceQuery(raw) {
    return raw.startsWith('"') ? raw.slice(1) : raw;
  }

  /// "@" 的异步候选。宿主(fileReferences/list 与 sessionReferenceResolver/candidates)
  /// 已按 query 做过匹配与排序,这里不再本地过滤 —— 本地那层会把宿主的模糊命中
  /// (如按路径中段、拼音首字母匹配到的结果)误删。
  async function referenceCandidates(source, query) {
    if (!state.sessionId) return [];
    const q = referenceQuery(query);
    const items = source === "reference-file"
      ? await deps.references.files(state.sessionId, q)
      : await deps.references.sessions(state.sessionId, q);
    return items ?? [];
  }

  /// 开一代新菜单并装填所有来源。文本触发与 ＋ 按钮共用。
  function loadSources(hit) {
    const sources = hit.trigger === "/" ? SLASH_SOURCES : atSources;
    menu = menuOnHit(menu, hit, sources);
    const generation = menu.generation;

    for (const source of sources) {
      const extra = extraBySource.get(source);
      if (extra || source.startsWith("reference-")) {   // 异步来源
        // extra 来源与宿主引用一样自带匹配排序;查询词同样要剥掉 @" 的开引号。
        const load = extra
          ? Promise.resolve(extra.candidates(referenceQuery(hit.query)))
          : referenceCandidates(source, hit.query);
        load
          .then((items) => { menu = menuOnSettled(menu, generation, source, items ?? []); render(); })
          .catch(() => { menu = menuOnFailed(menu, generation, source); render(); });
      } else {
        menu = menuOnSettled(menu, generation, source, localCandidates(source, hit.query));
      }
    }
    render();
  }

  function handleInput() {
    const caret = elements.input.selectionStart ?? elements.input.value.length;
    const hit = detectTrigger(elements.input.value, caret);
    if (!hit) { close(); return; }
    loadSources(hit);
  }

  /// ＋ 按钮入口:在光标处打开与 "@" 完全相同的浮层。
  ///
  /// 合成 hit 的 span 是**光标处的空区间** —— 选中候选时 applyPick/insertReference
  /// 会"替换"掉零个字符,也就是纯插入,不会动到用户已经打好的文本。
  function openAtCaret() {
    elements.input.focus();
    const caret = elements.input.selectionStart ?? elements.input.value.length;
    loadSources({
      trigger: "@",
      query: "",
      position: elements.input.value.slice(0, caret).trim() === "" ? "leading" : "inline",
      span: { start: caret, end: caret }
    });
  }

  /// ＋ 再点一次就收起,与它原来那个 #attach-menu 的 toggle 手感一致。
  function toggleAtCaret() {
    if (menu.open) { close(); return; }
    openAtCaret();
  }

  /// 点浮层与 ＋ 之外的地方就收起。
  /// 用 mousedown 而非 click:行内的选中也走 mousedown,用 click 的话会先关菜单再命中,选不中。
  function handleDocumentPointerDown(event) {
    if (!menu.open) return;
    if (elements.triggerMenu.contains(event.target)) return;
    if (elements.attachBtn?.contains(event.target)) return;
    close();
  }

  /// 返回 true 表示这次按键已被菜单消费,调用方不应再处理。
  function handleKeyDown(event) {
    if (!menu.open) return false;
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); menu = menuMove(menu, 1); render(); return true;
      case "ArrowUp": event.preventDefault(); menu = menuMove(menu, -1); render(); return true;
      case "Enter": {
        const item = menuHighlightedItem(menu);
        if (!item) return false;
        event.preventDefault();
        void pick(item);
        return true;
      }
      case "Escape": event.preventDefault(); close(); return true;
      case "Tab": {
        const item = menuHighlightedItem(menu);
        if (!item) return false;
        event.preventDefault();
        void pick(item);
        return true;
      }
      default: return false;
    }
  }

  return { handleInput, handleKeyDown, close, openAtCaret, toggleAtCaret, handleDocumentPointerDown };
}
