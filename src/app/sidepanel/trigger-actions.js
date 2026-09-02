// 候选浮层里的**固定行**:不引用任何东西,只执行一个动作。
//
// 目前两条,都排在文件/会话/子代理这些引用候选之前:
//   当前网页 → 把当前标签页的 tabId 插成胶囊(取代原来底栏的 #page-context-btn 开关);
//   添加图片 → 唤起文件选择器(取代原来加号的 #attach-menu)。
//
// 与引用候选的区别是它们带 action 字段,由 trigger-menu 的 pick() 分派。
// 拆出来是为了让 trigger-menu 专注在"检测触发 → 渲染 → 选中"这条主线上。
import { t } from "../../shared/i18n.js";
import { filterByFuzzy } from "./composer-triggers.js";

/// 固定行所属的来源名。顺序即渲染顺序,"当前网页"必须是第一行。
export const ACTION_SOURCES = Object.freeze(["page", "attach"]);

/// 这两条同属"上下文",共用一个分组标题 —— 各挂一条几乎一样的小字很吵。
export function isActionSource(source) {
  return source === "page" || source === "attach";
}

/**
 * 某个固定行来源在当前查询词下的候选。
 * 能力缺席时返回空数组(非扩展环境拿不到 tab、没接文件选择器),菜单里就不摆这一行。
 */
export function actionCandidates(source, query, { canCapturePage, canAttachImage } = {}) {
  if (source === "page") {
    if (!canCapturePage) return [];
    return filterByFuzzy([{
      name: t("pageCtx.current"), description: t("pageCtx.currentHint"), action: "page"
    }], query);
  }
  if (source === "attach") {
    if (!canAttachImage) return [];
    return filterByFuzzy([{ name: t("attach.image"), action: "attach-image" }], query);
  }
  return [];
}
