// 快捷键 pane。对齐 macos/.../Settings/ShortcutsWindow.swift:直接把命令表打印成
// 分区表格。它没有任何可写状态,也不碰宿主 —— 纯粹是命令表的一个视图,所以
// 不需要 settingsService,refresh() 也只是按当前语言/平台重画。
//
// 键位按平台显示当前平台那一档:两个平台的键位是独立设计的(见 command-table.js),
// 同时列出两套只会让用户去读不属于自己的那一半。
import { t } from "../../../shared/i18n.js";
import { section, row, escapeHtml } from "./settings-ui.js";
import { platformOf, shortcutReference } from "../../../features/shortcuts/command-table.js";

/// 和弦渲染成一串 <kbd>,每个修饰键与主键各自成块。
/// 按键 token 直接来自命令表(chordKeys),不解析 chordLabel 的成品字符串 ——
/// mac 的 "⌃⌘L" 没有分隔符可拆,按 "+" 拆只会把整条挤进一个键帽。
/// mac 的修饰键字形本身就是连写的,不插 "+";win 的习惯写法带 "+"。
function renderChord(keys, platformKind) {
  if (!keys?.length) return "";
  const caps = keys.map((key) => `<kbd class="sc-key">${escapeHtml(key)}</kbd>`);
  const separator = platformKind === "mac" ? "" : `<span class="sc-plus">+</span>`;
  return caps.join(separator);
}

export function createShortcutsPane({ host, platform }) {
  function render() {
    const kind = platformOf(platform ?? navigator.userAgentData?.platform ?? navigator.platform ?? "");
    // linux 跟随 win 键位,但标签仍报 Linux,不谎称 Windows。
    const platformName = t(`sc.platform.${kind}`);
    const groups = shortcutReference(kind === "mac" ? "mac" : "win");

    const body = groups.map((group) => section({
      header: t(`sc.section.${group.section}`),
      body: group.items.map((item) => row({
        label: escapeHtml(t(item.titleKey)),
        control: item.keys.length
          ? `<span class="sc-chord">${renderChord(item.keys, kind === "mac" ? "mac" : "win")}</span>`
          : `<span class="sc-chord-note">${escapeHtml(t(item.literalKey))}</span>`
      })).join("")
    })).join("");

    host.innerHTML = `<div class="sc-hint">${escapeHtml(t("sc.platformHint", { platform: platformName }))}</div>` + body;
  }

  return {
    async refresh() { render(); },
    stop() {}
  };
}
