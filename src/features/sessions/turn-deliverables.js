// 本轮产出词表(web ui-deliverables `turn-deliverables.ts` / mac TurnDeliverables.swift):
// 词表是第一方变更工具(write / edit / str_replace_editor)自己的调用参数(web `mutationPath`),
// 不是渲染视图、也不是收尾散文。读/删/失败调用不贡献。路径保持首见顺序、只出现一次。
// `present` 工具自己的声明走同一文件:显式的、耐久的交付清单,而非推导。

/// 尾部路径段(web `basename`,斜杠或反斜杠分隔)。
export function deliverablesBasename(path) {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at >= 0 ? path.slice(at + 1) : path;
}

/// 一条 settled 变更调用产出的路径(web `mutationPath`):从模型自己的参数解析,
/// 而非渲染视图。调用方在 settled 且非 error 的结果上把关。
export function producedPath(name, argsRaw) {
  let args;
  try { args = JSON.parse(argsRaw); } catch { return null; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  switch (name) {
    case "write":
      if (typeof args.content !== "string") return null;
      return pathValue(args.file_path);
    case "edit":
      if (typeof args.old_string !== "string" || args.old_string === ""
        || typeof args.new_string !== "string" || args.old_string === args.new_string
        || !(args.replace_all === undefined || typeof args.replace_all === "boolean")) return null;
      return pathValue(args.file_path);
    case "str_replace_editor":
      return editorMutationPath(args);
    default:
      return null;
  }
}

/// 只从完整的变更型 editor 命令里抽路径(web `editorMutationPath`)。
function editorMutationPath(args) {
  const path = pathValue(args.path);
  if (!path) return null;
  switch (args.command) {
    case "create":
      return typeof args.file_text === "string" ? path : null;
    case "str_replace":
      if (typeof args.old_str !== "string" || args.old_str === ""
        || !(args.new_str === undefined || typeof args.new_str === "string")) return null;
      return path;
    case "insert":
      return Number.isInteger(args.insert_line) && args.insert_line >= 0 && typeof args.new_str === "string"
        ? path : null;
    default:
      return null;
  }
}

/// 非空白路径保留调用所拼写的原样。
function pathValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/// `deliverables/presented` 事件携带的交付清单(web `isPresentedData` / mac `presented`):
/// 空白路径或非字符串条目不贡献,而非渲染一张打不开的卡。
export function presentedFiles(seq, data) {
  const turn = data?.turn;
  if (!Number.isInteger(turn) || turn < 1 || !Array.isArray(data?.files)) return null;
  const files = [];
  data.files.forEach((entry, index) => {
    const path = entry?.path;
    if (typeof path !== "string" || path.trim() === "") return;
    files.push({
      seq, index, path,
      description: typeof entry?.description === "string" ? entry.description : null
    });
  });
  return files.length ? { turn, files } : null;
}

/// `exit_plan_mode` 提交的计划(web ui-plan `submittedPlan` / mac SubmittedPlan):
/// 读参数里的 plan markdown,标题取其首行 `# ` 标题;没有标题的计划不出卡片。
export function submittedPlan(callId, argsRaw) {
  let args;
  try { args = JSON.parse(argsRaw); } catch { return null; }
  const markdown = args?.plan;
  if (typeof markdown !== "string") return null;
  const title = /^#\s+(\S[^\r\n]*)/.exec(markdown.trim())?.[1];
  return title ? { callId, title, markdown } : null;
}

/// 行内代码 mention 命名的那一个产出路径:精确路径匹配,或恰好唯一一个路径的 basename
/// (两个路径共享同一 basename 时返回 null,而非猜测)(web `onlyPathWithBasename`)。
export function resolveMention(value, paths) {
  if (paths.includes(value)) return value;
  const matches = paths.filter((p) => deliverablesBasename(p) === value);
  return matches.length === 1 ? matches[0] : null;
}
