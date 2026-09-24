// 出厂预设的"模式说明 / 如何使用"只读弹窗。
// 对齐 web ui-agent-preset PresetGuideDialog.tsx(presetGuide / GuideUsage)与
// Mac Components/Settings/PresetGuideSheet.swift(PresetGuide.forPreset / GuideSection.parse)。
// 文案在 i18n.js 的 pset.guide* 里,逐字照搬 web guide-locales.ts。
// 只读:打开、切页、复制示例都不会改默认预设。
import { t } from "../../../shared/i18n.js";
import { escapeHtml, button } from "./settings-ui.js";
import { isBuiltInPreset } from "../composer-dock.js";

/// 出厂 id → i18n key 片段。code 是 0.1.7 前 ptc 的旧名,历史 roster 里可能还有。
const GUIDE_KEYS = {
  standard: "Standard",
  ptc: "Ptc",
  code: "Ptc",
  minimal: "Minimal",
  cordis: "Cordis"
};

export const GUIDE_PAGES = ["explanation", "usage"];

/// 只有出厂预设有说明(web presetGuide(id, trust) 只认 trust === "system");
/// 自定义预设的能力描述归它自己。返回 { intro, explanation, usage } 三个 i18n key。
export function presetGuide(preset) {
  const name = isBuiltInPreset(preset) ? GUIDE_KEYS[preset.id] : undefined;
  if (!name) return undefined;
  return {
    intro: `pset.guide${name}Intro`,
    explanation: `pset.guide${name}Explanation`,
    usage: `pset.guide${name}Usage`
  };
}

/// 把说明正文拆成 `### ` 段(Mac GuideSection.parse):每段一个标题,
/// 段内按空行分块,`> ` 开头的是示例任务,其余是普通段落。
export function parseGuideSections(text) {
  return String(text ?? "").split(/^### /m).map((chunk) => {
    const parts = chunk.split("\n\n").map((part) => part.trim()).filter(Boolean);
    const title = parts.shift();
    if (!title) return null;
    return {
      title,
      blocks: parts.map((part) => part.startsWith("> ")
        ? { kind: "task", text: part.slice(2) }
        : { kind: "text", text: part })
    };
  }).filter(Boolean);
}

function renderSections(page, text) {
  return parseGuideSections(text).map((section, sectionIndex) => {
    const head = `<div class="pset-guide-section-head"><h3>${escapeHtml(section.title)}</h3>`
      + (page === "usage" ? `<span class="set-tag">${escapeHtml(t("pset.guideExampleTask"))}</span>` : "")
      + `</div>`;
    const blocks = section.blocks.map((block, blockIndex) => block.kind === "task"
      ? `<div class="pset-guide-task"><div class="pset-guide-task-text">${escapeHtml(block.text)}</div>`
        + `<button class="set-link pset-guide-copy" type="button" data-copy="${sectionIndex}-${blockIndex}">`
        + `${escapeHtml(t("copy"))}</button></div>`
      : `<p>${escapeHtml(block.text)}</p>`).join("");
    return `<section class="pset-guide-section">${head}${blocks}</section>`;
  }).join("");
}

/// 弹窗正文:简介 + 两页分段切换 + 两个面板(两页都渲染好,切页只改 hidden)。
export function renderGuideBody(guide, page) {
  const tab = (id, labelKey) => `<button class="set-subtab${page === id ? " active" : ""}"`
    + ` type="button" role="tab" data-guide-tab="${id}" aria-selected="${page === id}">`
    + `${escapeHtml(t(labelKey))}</button>`;
  return `<p class="set-sheet-text">${escapeHtml(t(guide.intro))}</p>`
    + `<div class="set-subtabs" role="tablist" aria-label="${escapeHtml(t("pset.guideSections"))}">`
    + tab("explanation", "pset.modeExplanation") + tab("usage", "pset.howToUse") + `</div>`
    + GUIDE_PAGES.map((id) => `<div class="pset-guide-panel" role="tabpanel" data-guide-page="${id}"`
      + `${page === id ? "" : " hidden"}>${renderSections(id, t(guide[id]))}</div>`).join("");
}

/// 打开说明弹窗。page 是初始页(web 卡片上"模式说明"/"如何使用"两个入口各开一页)。
/// 两页共用 sheet 的滚动容器,切页时各自记住滚动位置(web:各页签保留各自的滚动位置)。
export function openPresetGuide({ sheet, title, guide, page = "explanation" }) {
  const tasks = new Map();
  for (const id of GUIDE_PAGES) {
    parseGuideSections(t(guide[id])).forEach((section, sectionIndex) => {
      section.blocks.forEach((block, blockIndex) => {
        if (block.kind === "task") tasks.set(`${sectionIndex}-${blockIndex}`, block.text);
      });
    });
  }
  sheet.open({
    title,
    body: renderGuideBody(guide, page),
    actions: button({ id: "pset-guide-done", label: t("set.done"), kind: "primary" }),
    bind(root, token) {
      const scroller = root.querySelector(".set-sheet-body");
      const scrollTops = { explanation: 0, usage: 0 };
      let current = page;
      root.querySelector("#pset-guide-done")?.addEventListener("click", () => sheet.close(token));
      for (const tabButton of root.querySelectorAll("[data-guide-tab]")) {
        tabButton.addEventListener("click", () => {
          const next = tabButton.dataset.guideTab;
          if (next === current) return;
          if (scroller) scrollTops[current] = scroller.scrollTop;
          current = next;
          for (const other of root.querySelectorAll("[data-guide-tab]")) {
            const selected = other.dataset.guideTab === next;
            other.classList.toggle("active", selected);
            other.setAttribute("aria-selected", String(selected));
          }
          for (const panel of root.querySelectorAll("[data-guide-page]")) {
            panel.hidden = panel.dataset.guidePage !== next;
          }
          if (scroller) scroller.scrollTop = scrollTops[next];
        });
      }
      // 复制示例任务(Mac exampleTask 的复制按钮):按钮文字短暂变成"已复制"。
      for (const copyButton of root.querySelectorAll("[data-copy]")) {
        copyButton.addEventListener("click", async () => {
          const text = tasks.get(copyButton.dataset.copy);
          if (!text) return;
          try { await navigator.clipboard.writeText(text); } catch { return; /* 剪贴板不可用时静默 */ }
          if (!sheet.owns(token)) return;
          for (const other of root.querySelectorAll("[data-copy]")) other.textContent = t("copy");
          copyButton.textContent = t("copied");
        });
      }
    }
  });
}
