// 技能:skills/list(sessionId)拉取；调用即通过 session/prompt 发送 "/name"。
import { escapeHtml } from "../../shared/md-to-html.js";

export function createSkillService(connection) {
  let skills = [];
  let refreshGeneration = 0;
  const listeners = new Set();
  return {
    get skills() { return skills; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh(sessionId) {
      const generation = ++refreshGeneration;
      if (!sessionId) return skills;
      const value = await connection.call("skills/list", { request: { sessionId } });
      if (generation !== refreshGeneration) return skills;
      skills = value.skills ?? [];
      for (const listener of listeners) listener(skills);
      return skills;
    },
    // 技能调用 = 发送斜杠命令;modelInvocable=false 的技能仅用户可显式调用(行为一致)。
    async invoke(sessionId, name) {
      return connection.call("session/prompt", { request: {
        requestId: crypto.randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: `/${name}` }]
      } });
    }
  };
}

export function renderSkillsMenu(skills) {
  if (!skills.length) return "";
  // 这里曾经写成 `(a, b, c, "</div>")` —— 逗号表达式只返回最后一个值,整个菜单
  // 每项都只剩一个孤立的 </div>,技能名与描述全被丢掉。必须是一个模板字符串。
  return skills.map((skill) => `<div class="skill-row" data-skill-name="${escapeHtml(skill.name)}">` +
    `<code>/${escapeHtml(skill.name)}</code>` +
    `<span class="skill-desc">${escapeHtml(skill.description || "")}</span>` +
    "</div>").join("");
}
