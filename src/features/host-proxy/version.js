// 语义化版本比较(本扩展所需的最小子集)。
//
// 字典序比较有坑:"0.10.0" < "0.9.0" 会让每次跨 x.9 的发布都被判成没有新版,
// 所以主版本段必须按数值逐段比较;预发布号(-beta.1 等)按 semver 规则低于
// 同号正式版,预发布之间数字段按数值、字母段按字典序、数字段低于字母段。

function parse(version) {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? "").trim());
  if (!match) return null;
  return { main: match[1].split(".").map(Number), pre: match[2] ?? null };
}

function compareMain(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function comparePre(a, b) {
  // 无预发布 > 有预发布:1.0.0 > 1.0.0-beta。
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/// latest 严格高于 current 才算升级;解析不了任一侧一律 false(宁可漏报也不误报)。
export function isUpgrade(current, latest) {
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b) return false;
  const main = compareMain(a.main, b.main);
  if (main !== 0) return main < 0;
  return comparePre(a.pre, b.pre) < 0;
}
