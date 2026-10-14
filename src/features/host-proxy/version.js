// Strict SemVer 2.0.0, shared by target validation and precedence comparison.
// Decimal strings are compared without Number's precision loss; build metadata has no precedence.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const UPDATE_CHANNELS = Object.freeze(["latest", "next", "alpha"]);
function parse(version) {
  if (typeof version !== "string" || version.length > 256) return null;
  const match = SEMVER.exec(version);
  if (!match || match[0] !== version) return null;
  const pre = match[4]?.split(".") ?? null;
  if (pre?.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return null;
  return { main: match.slice(1, 4), pre };
}
export function isExactVersion(value) { return Boolean(parse(value)); }
export function validateUpdateTarget(value = "latest") {
  if (UPDATE_CHANNELS.includes(value) || isExactVersion(value)) return value;
  throw new TypeError("DSH update target must be latest, next, alpha or an exact semantic version");
}
function decimal(a, b) {
  return a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length < b.length ? -1 : 1;
}
export function compareVersions(left, right) {
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) { const c = decimal(a.main[i], b.main[i]); if (c) return c; }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    const c = xn && yn ? decimal(x, y) : xn !== yn ? (xn ? -1 : 1) : x === y ? 0 : x < y ? -1 : 1;
    if (c) return c;
  }
  return 0;
}
export function isUpgrade(current, target) { return compareVersions(current, target) === -1; }
