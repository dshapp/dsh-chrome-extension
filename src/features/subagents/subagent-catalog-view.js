// 子代理目录入口的 DOM 层:header chip + 树形 popover。对齐 Mac SubagentCatalogAction/Level/Row。
import { t } from "../../shared/i18n.js";
import {
  createSubagentCatalogState, catalogVisible, catalogTriggerLabel,
  childSecondaryText, diagnosticReasonText, subagentTokenTotal, subagentDurationMs,
  formatSubagentTokens, formatSubagentDuration, formatSubagentExactDuration
} from "./subagent-catalog.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**.
 * @param trigger  header 里的触发 chip(#subagent-catalog-btn)。
 * @param menu     目录 popover(#subagent-catalog-menu)。
 * @param deps     组装依赖(需要 deps.sessions.listStore / listSubagents)。
 * @param getSessionId  当前打开的父会话 id。
 * @param onOpenSubagent(address) 点击 healthy child 行时回调。
 */
export function mountSubagentCatalog(trigger, menu, { deps, getSessionId, onOpenSubagent }) {
  const catalog = createSubagentCatalogState();
  const listStore = deps.sessions.listStore;
  const labelSpan = trigger.querySelector(".subagent-label");
  const dotSpan = trigger.querySelector(".subagent-dot");
  let refreshTimer = null;
  let opened = false; // 用 toggle 事件维护,避免依赖 :popover-open(jsdom 不支持)

  function summariesById() {
    const map = new Map();
    for (const s of listStore.get()) map.set(s.sessionId, s);
    return map;
  }

  function loader(parentId) {
    return deps.sessions.listSubagents(parentId);
  }

  async function load(parentId, force = false) {
    await catalog.load(parentId, loader, { force });
    if (parentId === getSessionId()) paintTrigger();
    render();
  }

  function descOfRoot() {
    return listStore.subagentDescendants(getSessionId());
  }

  function paintTrigger() {
    const sid = getSessionId();
    if (!sid) { trigger.hidden = true; return; }
    const st = catalog.stateFor(sid);
    const desc = listStore.subagentDescendants(sid);
    const visible = catalogVisible(st, desc);
    trigger.hidden = !visible;
    if (!visible) { menu.hidePopover?.(); return; }
    labelSpan.textContent = catalogTriggerLabel(st, desc, t);
    dotSpan.classList.toggle("running", desc.runningCount > 0);
  }

  function render() {
    const sid = getSessionId();
    if (!sid || trigger.hidden) { menu.replaceChildren(); return; }
    const panel = el("div", "subagent-panel");
    renderLevel(sid, 1, panel);
    menu.replaceChildren(panel);
  }

  function renderLevel(parentId, level, container) {
    const st = catalog.stateFor(parentId);
    if (st.phase === "failed") {
      container.append(renderError(st.error, parentId));
      return;
    }
    if (st.phase !== "ready") {
      container.append(renderLoading(parentId, level));
      return;
    }
    const entries = st.value?.entries ?? [];
    // 目录里只要有一个 healthy 行是分支,就整层预留 disclosure 列,行首对齐。
    const reserveDisclosure = entries.some((e) => e.kind === "child" && e.hasChildren);
    const list = el("div", "subagent-level");
    for (const entry of entries) {
      if (entry.kind === "diagnostic") {
        list.append(renderDiagnosticRow(entry, reserveDisclosure));
      } else {
        const byId = summariesById();
        const expanded = catalog.expanded.has(entry.id);
        list.append(renderChildRow(parentId, entry, reserveDisclosure, expanded, level, byId));
        if (entry.hasChildren && expanded) {
          const sub = el("div", "subagent-child-level");
          renderLevel(entry.id, level + 1, sub);
          list.append(sub);
        }
      }
    }
    container.append(list);
  }

  function renderError(message, parentId) {
    const row = el("div", "subagent-error");
    row.append(el("span", "subagent-error-text", message || t("subagentCatalogLoadError")));
    const retry = el("button", "subagent-retry", t("retry"));
    retry.type = "button";
    retry.addEventListener("click", () => { load(parentId, true); });
    row.append(retry);
    return row;
  }

  function renderLoading(parentId, level) {
    const children = listStore.subagentChildren().get(parentId) ?? [];
    if (!children.length) {
      const row = el("div", "subagent-loading", t("subagentCatalogLoading"));
      return row;
    }
    const wrap = el("div", "subagent-level");
    for (const child of children) {
      const row = el("div", "subagent-row subagent-row-placeholder");
      row.append(el("span", "subagent-dot"));
      row.append(el("span", "subagent-name", t("subagentCatalogLoading")));
      wrap.append(row);
    }
    return wrap;
  }

  function renderDiagnosticRow(entry, reserveDisclosure) {
    const row = el("div", "subagent-row subagent-row-diagnostic");
    if (reserveDisclosure) row.append(el("span", "subagent-disclosure spacer"));
    row.append(el("span", "subagent-dot error"));
    const main = el("span", "subagent-main");
    main.append(el("span", "subagent-name", entry.id));
    main.append(el("span", "subagent-secondary", diagnosticReasonText(entry.reason, t)));
    row.append(main);
    return row;
  }

  function renderChildRow(parentId, entry, reserveDisclosure, expanded, level, byId) {
    const summary = byId.get(entry.id);
    const summaryTitle = summary?.projections?.values?.title || null;
    const displayLabel = (entry.label ?? summaryTitle ?? entry.id);
    // title 与目录 label 相同时不再在次级文案里复述一遍。
    const secondaryTitle = (summaryTitle && summaryTitle !== entry.label) ? summaryTitle : null;
    const secondary = childSecondaryText(entry.mode, entry.activity, secondaryTitle, t);

    const row = el("div", "subagent-row");
    row.style.setProperty("--subagent-level", String(level));

    // disclosure 列:分支才可展开,否则占位保持对齐。
    if (entry.hasChildren) {
      const disc = el("button", "subagent-disclosure" + (expanded ? " open" : ""));
      disc.type = "button";
      disc.setAttribute("aria-expanded", String(expanded));
      disc.setAttribute("aria-label", t(expanded ? "subagentCollapseDescendants" : "subagentExpandDescendants", { name: displayLabel }));
      disc.textContent = expanded ? "▾" : "▸";
      disc.addEventListener("click", (event) => {
        event.stopPropagation();
        catalog.toggle(entry.id, (childId) => load(childId));
        render();
      });
      row.append(disc);
    } else if (reserveDisclosure) {
      row.append(el("span", "subagent-disclosure spacer"));
    }

    const open = el("button", "subagent-row-open");
    open.type = "button";
    open.addEventListener("click", () => {
      onOpenSubagent({ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode });
      menu.hidePopover?.();
    });

    open.append(el("span", "subagent-dot" + (entry.activity === "running" ? " running" : "")));
    const main = el("span", "subagent-main");
    main.append(el("span", "subagent-name", displayLabel));
    main.append(el("span", "subagent-secondary", secondary));
    open.append(main);

    // 右侧指标:token + 时长。
    const tokenTotal = subagentTokenTotal(summary);
    const duration = subagentDurationMs(summary, Date.now());
    if (tokenTotal != null || duration != null) {
      const metrics = el("span", "subagent-metrics");
      if (tokenTotal != null) metrics.append(el("span", "subagent-metric", formatSubagentTokens(tokenTotal) + " tok"));
      if (duration != null) {
        const d = el("span", "subagent-metric", formatSubagentDuration(duration));
        d.title = t("subagentTotalActiveDuration", { duration: formatSubagentExactDuration(duration) });
        metrics.append(d);
      }
      open.append(metrics);
    }

    row.append(open);
    return row;
  }

  // ---- 生命周期 ----
  menu.addEventListener("toggle", (event) => {
    opened = event.newState === "open";
    if (opened) {
      const sid = getSessionId();
      if (sid) { load(sid); armliveRefresh(); }
    } else {
      catalog.close();
      disarmRefresh();
    }
  });

  function armliveRefresh() {
    disarmRefresh();
    // 运行中的行要显示"距开跑已过多久";有 running 才 1s 刷一次,否则静态。
    if (descOfRoot().runningCount > 0) {
      refreshTimer = setInterval(render, 1000);
    }
  }
  function disarmRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  return {
    /// 数据/会话变化时由外部调用:更新 chip 而在 popover 开着时重画。
    refresh() {
      paintTrigger();
      if (opened) render();
    }
  };
}
