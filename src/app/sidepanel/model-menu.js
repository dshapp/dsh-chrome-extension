// composer 模型菜单的渲染:目录超过 4 个模型时顶部加一个搜索框(dsh 0.2 web ModelSelect)。
// 菜单条目本身仍走通用 renderMenuItems;这里只负责搜索框、过滤与键盘接力。
import { t } from "../../shared/i18n.js";
import { renderMenuItems } from "./menu-items.js";
import { modelMenuGroups, modelCount, MODEL_SEARCH_THRESHOLD } from "../../features/models/model-ranking.js";

/// 每个菜单容器的搜索状态。重画(目录刷新、选模型后)不应清掉正在输入的查询。
const menuState = new WeakMap();

/// 把分组(已按供应商排序)摊平成菜单条目。id 形如 provider::model,与选择回调约定一致。
export function modelMenuEntries(groups) {
  return groups.flatMap((group) => (group.models ?? []).map((model) => ({
    id: group.id + "::" + model.id,
    label: model.name || model.id,
    // 不给 hint:分组标题已经写着 provider 名,行内再挂一份是重复信息。
    section: group.name,
    provider: group.id,
    model: model.id
  })));
}

/**
 * @param {HTMLElement} container popover 容器(#model-menu)。
 * @param {object} options
 * @param {Array} options.groups 已按供应商排好序的 groups。
 * @param {Array} options.extraEntries 附在模型之后的条目(推理档),搜索时隐藏。
 * @param {string|null} options.selectedId 当前模型的条目 id。
 * @param {(id: string) => void} options.onSelect
 */
export function renderModelMenu(container, { groups, extraEntries = [], selectedId, onSelect }) {
  const showSearch = modelCount(groups) > MODEL_SEARCH_THRESHOLD;
  if (!showSearch) {
    menuState.delete(container);
    renderMenuItems(container, [...modelMenuEntries(groups), ...extraEntries], {
      selectedId, onSelect, groupBy: (entry) => entry.section
    });
    return;
  }

  let state = menuState.get(container);
  if (!state) {
    const search = document.createElement("input");
    // type=text 而不是 search:search 框吞掉第一下 Esc 去清空内容,菜单要按两次才关。
    search.type = "text";
    search.className = "menu-search";
    search.autocomplete = "off";
    search.spellcheck = false;
    const list = document.createElement("div");
    list.className = "menu-search-list";
    state = { search, list, query: "", options: null };
    menuState.set(container, state);
    search.addEventListener("input", () => { state.query = search.value; paint(state); });
    search.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.list.querySelector(".menu-item")?.focus();
      } else if (event.key === "Enter") {
        // Enter 接受第一条命中(web:有搜索时焦点留在搜索框,Enter/Tab 接受高亮项)。
        const first = state.list.querySelector("[data-item-id]");
        if (first) {
          event.preventDefault();
          state.options.onSelect(first.dataset.itemId);
        }
      }
    });
    list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const items = [...list.querySelectorAll(".menu-item")];
      const at = items.indexOf(document.activeElement);
      if (at < 0) return;
      event.preventDefault();
      if (event.key === "ArrowUp" && at === 0) search.focus();
      else items[Math.min(items.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    });
    // 每次打开菜单都从空查询开始,并把焦点交给搜索框(web:重开 model pane 清空 query)。
    container.addEventListener("toggle", (event) => {
      if (event.newState !== "open" || !menuState.get(container)) return;
      state.query = "";
      search.value = "";
      paint(state);
      search.focus();
    });
  }
  state.search.placeholder = t("model.searchPlaceholder");
  state.search.setAttribute("aria-label", t("model.searchPlaceholder"));
  state.options = { groups, extraEntries, selectedId, onSelect };
  container.onclick = null;
  container.replaceChildren(state.search, state.list);
  paint(state);
}

function paint(state) {
  const { groups, extraEntries, selectedId, onSelect } = state.options;
  const query = state.query.trim();
  const entries = modelMenuEntries(modelMenuGroups(groups, query));
  renderMenuItems(state.list, query ? entries : [...entries, ...extraEntries], {
    selectedId, onSelect, groupBy: (entry) => entry.section, emptyText: t("model.searchEmpty")
  });
}
