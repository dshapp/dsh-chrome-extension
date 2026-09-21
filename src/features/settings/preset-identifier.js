// 预设标识符校验(纯逻辑,便于单测)。
//
// 标识符同时是预设目录名,所以规则比"看起来像名字"严格得多 —— 逐字对齐
// Mac CopyPresetSheet 里那条正则与 web D41 的本地占用预检:一个已被别的
// roster 条目占用的 id 在本地就拦下,不等宿主报错(宿主的拒绝信息对用户
// 来说只是一串 code)。

export const PRESET_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/// 合法:小写字母开头,后接小写字母/数字,可用单个连字符分组。
export function isPresetIdValid(id) {
  return PRESET_ID_PATTERN.test(String(id ?? ""));
}

/// 是否已被 roster 里的条目占用(含内置预设 —— 覆盖内置 id 同样要拦)。
export function isPresetIdOccupied(id, presets) {
  const value = String(id ?? "");
  if (!value) return false;
  return (presets ?? []).some((preset) => preset?.id === value);
}

/// 复制弹窗的确认条件:标识符合法、未被占用、且没有正在进行的复制。
export function canConfirmPresetCopy({ id, presets, copying } = {}) {
  return presetCopyProblem({ id, presets, copying }) === null;
}

/// 不能确认的**原因**,按用户看到的先后顺序:先报"格式不对"再报"已被占用"。
/// 非法 + 同名同时成立时报 invalid —— 用户先要改的是那个非法字符,
/// 而一条"已被占用"的提示会把他引向换名字(问题依旧)。
/// 返回 null 表示可以确认。
export function presetCopyProblem({ id, presets, copying } = {}) {
  if (!isPresetIdValid(id)) return "invalid";
  if (isPresetIdOccupied(id, presets)) return "occupied";
  if (copying) return "busy";
  return null;
}

/// 新建会话时用的默认标识符建议?Mac 只给 placeholder "my-agent",
/// 这里保持一致 —— 不替用户预设一个可能被占用的 id。
export const PRESET_ID_PLACEHOLDER = "my-agent";
