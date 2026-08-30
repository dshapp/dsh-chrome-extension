// composer 的 "/" 与 "@" 触发检测与分组候选菜单状态机。
// 对齐 macos/.../Models/ComposerTriggerModels.swift + State/ComposerTriggerController.swift。
//
// 纯逻辑:不碰 DOM。generation 用来拒绝迟到的异步来源结果——
// 用户已经改了查询词,上一批候选再回来就不能覆盖当前菜单。

/// 触发必须位于文本开头或空白之后,且触发符与光标之间不能有空白。
const TRIGGERS = ["/", "@"];

/// 词字符:候选名允许字母数字与 - _ . /(路径要用到 . 与 /)。
function isWordish(ch) {
  return /[\w\-./]/.test(ch);
}

/// 检测光标处的触发。返回 null 表示当前不在触发态。
export function detectTrigger(text, caret) {
  const before = text.slice(0, caret);

  // 先处理带引号的 mention:@"path with spaces 里空白是内容的一部分,
  // 普通的"遇空白即停"扫描会把它当成 token 边界,于是含空格的路径一插入就
  // 再也无法继续补全或下钻。只要光标前存在一个未闭合的 @" ,它就是当前触发。
  const quoted = /(?:^|\s)@"([^"]*)$/.exec(before);
  if (quoted) {
    const start = quoted.index + (quoted[0].startsWith("@") ? 0 : 1);
    return {
      trigger: "@",
      // query 保留开引号,交由调用方剥离(见 trigger-menu 的 referenceQuery)。
      query: '"' + quoted[1],
      position: before.slice(0, start).trim() === "" ? "leading" : "inline",
      span: { start, end: caret }
    };
  }

  // 从光标往回扫,遇到空白就停;沿途找位于边界(行首或空白后)的触发符。
  //
  // 不在边界上的触发符必须**跳过而不是否决**:路径里的 '/' 本身也是触发符,
  // 如果一遇到就 return null,那么 "@src/features" 与目录下钻后的 "@content/"
  // 都永远检测不到触发,'@' 引用实质上只能用于顶层无斜杠的名字。
  let i = before.length - 1;
  while (i >= 0) {
    const ch = before[i];
    if (/\s/.test(ch)) return null;
    if (TRIGGERS.includes(ch)) {
      const prev = i === 0 ? null : before[i - 1];
      if (prev === null || /\s/.test(prev)) {
        return {
          trigger: ch,
          query: before.slice(i + 1),
          position: before.slice(0, i).trim() === "" ? "leading" : "inline",
          span: { start: i, end: caret }
        };
      }
      // 非边界触发符(路径分隔符、a@b 里的 @):继续往前找真正的触发点。
    }
    i -= 1;
  }
  return null;
}

/// 大小写不敏感的子序列模糊打分。前缀命中最高,词首/-/_ 边界次之。
export function fuzzyScore(name, query) {
  if (!query) return 0;
  const lowerName = String(name).toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName.startsWith(lowerQuery)) return 100;
  let score = 0;
  let cursor = 0;
  for (const ch of lowerQuery) {
    const idx = lowerName.indexOf(ch, cursor);
    if (idx === -1) return -1;
    const atBoundary = idx === 0 || "-_/.".includes(lowerName[idx - 1]);
    score += atBoundary ? 3 : (idx === cursor ? 2 : 1);
    cursor = idx + 1;
  }
  return score;
}

export function filterByFuzzy(items, query, nameOf = (x) => x.name) {
  if (!query) return [...items];
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(nameOf(item), query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.item);
}

/// 菜单状态机。groups 是有序的来源分组,highlight 指向 (source, index)。
export function createMenuState() {
  return { open: false, hit: null, generation: 0, groups: [], highlight: null };
}

/// 新的触发命中:开一代新菜单,来源置为 pending。
export function menuOnHit(state, hit, sources) {
  if (!hit) return { ...createMenuState(), generation: state.generation + 1 };
  return {
    open: true,
    hit,
    generation: state.generation + 1,
    groups: sources.map((source) => ({ source, status: "pending", items: [] })),
    highlight: null
  };
}

/// 某个来源返回了候选。generation 不匹配说明它属于上一次查询,丢弃。
export function menuOnSettled(state, generation, source, items) {
  if (generation !== state.generation || !state.open) return state;
  const groups = state.groups.map((group) =>
    group.source === source ? { source, status: "ready", items } : group);
  const next = { ...state, groups };
  // 首个可用候选自动高亮,让 Enter 立刻可用。
  if (!next.highlight) next.highlight = firstHighlight(groups);
  return next;
}

export function menuOnFailed(state, generation, source) {
  if (generation !== state.generation) return state;
  return { ...state, groups: state.groups.map((g) => (g.source === source ? { ...g, status: "ready", items: [] } : g)) };
}

function firstHighlight(groups) {
  for (const group of groups) {
    if (group.items.length) return { source: group.source, index: 0 };
  }
  return null;
}

/// 扁平化为可遍历的行序列(跨组移动高亮用)。
export function menuRows(state) {
  return state.groups.flatMap((group) => group.items.map((item, index) => ({ source: group.source, index, item })));
}

/// 上下移动高亮,跨组循环。
export function menuMove(state, delta) {
  const rows = menuRows(state);
  if (!rows.length) return state;
  const current = rows.findIndex((r) => r.source === state.highlight?.source && r.index === state.highlight?.index);
  const next = current === -1
    ? (delta > 0 ? 0 : rows.length - 1)
    : (current + delta + rows.length) % rows.length;
  return { ...state, highlight: { source: rows[next].source, index: rows[next].index } };
}

export function menuHighlightedItem(state) {
  if (!state.highlight) return null;
  const group = state.groups.find((g) => g.source === state.highlight.source);
  return group?.items[state.highlight.index] ?? null;
}

export function menuClose(state) {
  return { ...createMenuState(), generation: state.generation + 1 };
}

/// 把选中的候选插回文本。
/// 返回 { text, caret, keepOpen } —— keepOpen 为真时(目录下钻)调用方要重新检测触发。
///
/// candidate.value 是**已经格式化好的完整 mention 文本**(含前导 '@'、必要的引号、
/// 目录的结尾斜杠),由 reference-service 的 formatFileMention 或宿主直接给出,
/// 这里原样插入。只有没有 value 的候选(命令/技能)才在这里拼触发符。
export function applyPick(text, hit, candidate) {
  const before = text.slice(0, hit.span.start);
  const after = text.slice(hit.span.end);
  const token = candidate.value ?? `${hit.trigger}${candidate.name}`;
  // 目录候选:插入 "@dir/" 后不补空格也不关闭菜单,让触发检测再跑一次、降一级。
  if (candidate.insertsPlainText) {
    return { text: `${before}${token}${after}`, caret: before.length + token.length, keepOpen: true };
  }
  const inserted = `${token} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length, keepOpen: false };
}

// ---- 草稿装饰 ----

/// 推导草稿高亮区间(web deriveDecorations + scanTextRefs 的移植)。
/// lexicon: { "/": Set<string>, "@": Set<string> } —— 已知可解析的名字。
/// 已知名 → textRef(业务色);未知的 @name → invalidRef(错误色),直到它能解析。
export function deriveDecorations(draft, lexicon = {}) {
  const result = [];
  if (!draft) return result;
  const chars = [...draft];
  let index = 0;
  while (index < chars.length) {
    const prev = index === 0 ? null : chars[index - 1];
    const atBoundary = prev === null || /\s/.test(prev);
    if (!atBoundary) { index += 1; continue; }
    const trigger = chars[index];
    if (!TRIGGERS.includes(trigger)) { index += 1; continue; }
    let end = index + 1;
    while (end < chars.length && isWordish(chars[end])) end += 1;
    if (end === index + 1) { index += 1; continue; }
    const name = chars.slice(index + 1, end).join("");
    const names = lexicon[trigger];
    if (names?.has(name)) {
      result.push({ start: index, end, kind: "textRef" });
    } else if (trigger === "@") {
      // @ 引用只对活着的会话/路径解析,未知名先标红。
      result.push({ start: index, end, kind: "invalidRef" });
    }
    index = end;
  }
  return result;
}
