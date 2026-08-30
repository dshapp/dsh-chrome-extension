// 一张插件卡片的暂存编辑态。对齐 macos/Sources/DSHMacKit/State/PluginSettingsState.swift。
//
// 三层设置(base 适配器基线 / user 用户层 / value 折算结果)决定了三件事:
// 显示什么(value)、是否显示"已覆盖"标记(user 是否拥有该键)、以及"恢复默认"
// 要还原到什么(base)。少了任何一层,重置就只能猜。

/// 把已折算的 JSON 值格式化成可编辑文本。
export function formatFieldValue(kind, value) {
  if (kind === "number" && typeof value === "number") return String(value);
  if (kind === "text" && typeof value === "string") return value;
  return "";
}

/// 解析草稿文本 → {ok, value};value 为 null 表示"清除该键"。
export function parseFieldValue(kind, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: true, value: null };
  if (kind === "number") {
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return { ok: false, value: null };
    return { ok: true, value };
  }
  return { ok: true, value: trimmed };
}

export function createPluginSettingsState({ namespace, writable, fields }) {
  let current = namespace;
  const drafts = new Map();
  const draftOrder = [];

  const valueObject = () => (current?.value && typeof current.value === "object" ? current.value : {});
  const baseObject = () => (current?.base && typeof current.base === "object" ? current.base : {});
  const userObject = () => (current?.user && typeof current.user === "object" ? current.user : {});

  /// 待写计划:每项是 {field, value} 或 null(该字段当前非法)。
  /// 草稿文本与折算值相同的字段不产生 op —— 打开卡片不该等于"已修改"。
  function plan() {
    const result = [];
    for (const name of draftOrder) {
      const draft = drafts.get(name);
      const kind = fields[name];
      if (!draft || !kind) continue;
      if (draft.reset) {
        if (Object.hasOwn(userObject(), name)) result.push({ field: name, value: null });
        continue;
      }
      if (draft.text === formatFieldValue(kind, valueObject()[name])) continue;
      const parsed = parseFieldValue(kind, draft.text);
      result.push(parsed.ok ? { field: name, value: parsed.value } : null);
    }
    return result;
  }

  return {
    get namespace() { return current; },
    get writable() { return writable; },
    get dirty() { return plan().length > 0; },
    get invalid() { return plan().some((item) => item === null); },

    /// 某字段当前的渲染态。
    field(name) {
      const kind = fields[name];
      if (!kind) throw new Error(`未知插件设置字段 ${name}`);
      const draft = drafts.get(name);
      if (!draft) {
        return {
          text: formatFieldValue(kind, valueObject()[name]),
          overridden: Object.hasOwn(userObject(), name),
          invalid: false
        };
      }
      const parsed = draft.reset ? { ok: true, value: null } : parseFieldValue(kind, draft.text);
      return {
        text: draft.text,
        overridden: parsed.ok && parsed.value !== null,
        invalid: !parsed.ok
      };
    },

    edit(name, text) {
      if (!fields[name]) throw new Error(`未知插件设置字段 ${name}`);
      if (!drafts.has(name)) draftOrder.push(name);
      drafts.set(name, { text, reset: false });
    },

    /// 暂存"删除用户层该键",并显示继承来的值。
    reset(name) {
      const kind = fields[name];
      if (!kind) throw new Error(`未知插件设置字段 ${name}`);
      if (!drafts.has(name)) draftOrder.push(name);
      drafts.set(name, { text: formatFieldValue(kind, baseObject()[name]), reset: true });
    },

    discard() {
      drafts.clear();
      draftOrder.length = 0;
    },

    /// 合法的路径 op 列表;任一字段非法时返回 null。
    get mutations() {
      const planned = plan();
      if (planned.some((item) => item === null)) return null;
      return planned.map((item) => ({
        op: item.value === null ? "unset" : "set",
        path: [item.field],
        ...(item.value === null ? {} : { value: item.value })
      }));
    },

    /// 采纳权威写回结果,只清掉真正落地的草稿。
    settle(settled) {
      const planned = plan();
      if (planned.some((item) => item === null)) return;
      current = settled;
      for (const item of planned) {
        const landed = item.value === null
          ? !Object.hasOwn(userObject(), item.field)
          : userObject()[item.field] === item.value;
        if (landed) {
          drafts.delete(item.field);
          const index = draftOrder.indexOf(item.field);
          if (index !== -1) draftOrder.splice(index, 1);
        }
      }
    }
  };
}
