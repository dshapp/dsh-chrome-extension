// "/" 与 "@" 触发候选菜单的 DOM 层。状态机在 composer-triggers.js。
//
// 来源:"/" → commands + skills(本地已缓存,同步结算);
//       "@" → 文件路径(host.listDirectory,异步)+ 已知 subagent 会话。
import { t } from "../../shared/i18n.js";
import { insertReference } from "./composer-chips.js";
import {
  detectTrigger, filterByFuzzy, createMenuState, menuOnHit, menuOnSettled,
  menuOnFailed, menuMove, menuHighlightedItem, menuClose, applyPick
} from "./composer-triggers.js";

const SLASH_SOURCES = ["commands", "skills"];
// 对齐 Mac 的 '@' 来源集合:工作区文件 + 历史会话(异步 RPC)+ 运行中的子代理(本地)。
const AT_SOURCES = ["reference-file", "reference-session", "subagent"];

export function mountTriggerMenu({ elements, deps, state, onInsertReference, getOccurrences }) {
  let menu = createMenuState();

  function close() {
    menu = menuClose(menu);
    elements.triggerMenu.hidden = true;
    elements.triggerMenu.replaceChildren();
  }

  function sectionLabel(source) {
    if (source === "commands") return t("menu.commands");
    if (source === "skills") return t("skills.title");
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
    for (const group of menu.groups) {
      if (group.status === "pending") {
        // 异步来源:先占位,避免菜单在等待期间闪烁成空。
        if (group.source.startsWith("reference-")) {
          const pending = document.createElement("div");
          pending.className = "trigger-pending";
          pending.textContent = "…";
          container.append(pending);
        }
        continue;
      }
      if (!group.items.length) continue;
      const label = document.createElement("div");
      label.className = "trigger-group-label";
      label.textContent = sectionLabel(group.source);
      container.append(label);
      group.items.forEach((item, index) => {
        rows += 1;
        const row = document.createElement("div");
        row.className = "trigger-item";
        row.setAttribute("role", "option");
        if (menu.highlight?.source === group.source && menu.highlight.index === index) {
          row.classList.add("highlighted");
          highlightedRow = row;
        }
        const name = document.createElement("span");
        name.className = "trigger-item-name";
        // '@' 引用候选自带展示名(如「文件 · chat-view.js」),不再前缀触发符;
        // 命令/技能候选才拼上 '/'。
        name.textContent = item.value ? item.name : `${menu.hit.trigger}${item.name}`;
        row.append(name);
        if (item.description) {
          const hint = document.createElement("span");
          hint.className = "trigger-item-hint";
          hint.textContent = item.description;
          row.append(hint);
        }
        // mousedown 而非 click:click 之前 textarea 会先失焦,插入位置就丢了。
        row.addEventListener("mousedown", (event) => { event.preventDefault(); pick(item); });
        container.append(row);
      });
    }
    if (!rows && !menu.groups.some((g) => g.status === "pending")) { close(); return; }
    container.hidden = false;
    // 菜单高度封顶(18rem)且可滚动:方向键把高亮移出可视区时列表必须跟着滚,
    // 否则用户看到的是"上下键没反应"——高亮其实在视口外移动。
    // 必须在 hidden = false 之后:隐藏元素没有布局,scrollIntoView 是空操作。
    // jsdom 等无布局环境没有这个方法,可选调用即可(那里也无所谓滚动)。
    highlightedRow?.scrollIntoView?.({ block: "nearest" });
  }

  function pick(candidate) {
    if (!menu.hit) return;
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
      const next = insertReference(elements.input.value, getOccurrences?.() ?? [], menu.hit.span, {
        label, text
      });
      elements.input.value = next.text;
      onInsertReference(next);
      elements.input.focus();
      elements.input.setSelectionRange(next.caret, next.caret);
      // 不派发 input 事件:占位符已由 onInsertReference 同步好,
      // 再走一遍 syncChips 会用旧 lastDraft 去 diff,把刚插入的胶囊判成孤儿。
      elements.input.dispatchEvent(new Event("change", { bubbles: true }));
      close();
      return;
    }
    const { text, caret, keepOpen } = applyPick(elements.input.value, menu.hit, candidate);
    elements.input.value = text;
    elements.input.focus();
    elements.input.setSelectionRange(caret, caret);
    elements.input.dispatchEvent(new Event("input", { bubbles: true }));
    if (!keepOpen) close();
    // keepOpen(目录下钻)时不关:上面的 input 事件会重新检测触发并降一级。
  }

  /// 同步来源:命令与技能已在本地缓存。
  function localCandidates(source, query) {
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

  function handleInput() {
    const caret = elements.input.selectionStart ?? elements.input.value.length;
    const hit = detectTrigger(elements.input.value, caret);
    if (!hit) { close(); return; }

    const sources = hit.trigger === "/" ? SLASH_SOURCES : AT_SOURCES;
    menu = menuOnHit(menu, hit, sources);
    const generation = menu.generation;

    for (const source of sources) {
      if (source.startsWith("reference-")) {   // 异步来源
        referenceCandidates(source, hit.query)
          .then((items) => { menu = menuOnSettled(menu, generation, source, items); render(); })
          .catch(() => { menu = menuOnFailed(menu, generation, source); render(); });
      } else {
        menu = menuOnSettled(menu, generation, source, localCandidates(source, hit.query));
      }
    }
    render();
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
        pick(item);
        return true;
      }
      case "Escape": event.preventDefault(); close(); return true;
      case "Tab": {
        const item = menuHighlightedItem(menu);
        if (!item) return false;
        event.preventDefault();
        pick(item);
        return true;
      }
      default: return false;
    }
  }

  return { handleInput, handleKeyDown, close };
}
