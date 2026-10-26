// 附件:图片内联 base64(DSH 原生支持);非图片(工作区外文件,浏览器读不到
// 真实路径)走 session/uploadFileBinary 真上传,换回 receiptId 由 session/prompt 的
// file content part 消费(DSH 1.5)。
//
// 图片限制以宿主 imageLimits 投影为准(mediaTypes / maxImageBytes /
// maxImagesPerMessage / maxMessageImageBytes)。非图片文件没有图片的类型/张数/
// 总字节三类约束,只受"会话未就绪时不能上传"影响(注入的 uploadFile 拿不到
// 会话 id 时抛 attach.noSession)。

import { escapeHtml } from "../../shared/md-to-html.js";
import { t } from "../../shared/i18n.js";
import { lucideIconSvg } from "../chat/file-icons.js";

/// 宿主未下发投影前的保守兜底(与 DSH attachment 包的默认值一致)。
const FALLBACK_LIMITS = Object.freeze({
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024
});

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/// 校验一个待加入的图片。返回 null 表示通过,否则返回人读的拒绝原因。
export function validateImage(file, limits, existing = []) {
  const l = { ...FALLBACK_LIMITS, ...(limits ?? {}) };
  const types = l.mediaTypes ?? FALLBACK_LIMITS.mediaTypes;
  if (!types.includes(file.type)) {
    return { key: "attach.badType", params: { name: file.name || "image" } };
  }
  if (file.size > l.maxImageBytes) {
    return { key: "attach.tooLarge", params: { name: file.name || "image", limit: formatBytes(l.maxImageBytes) } };
  }
  if (existing.length >= l.maxImagesPerMessage) {
    return { key: "attach.tooMany", params: { max: String(l.maxImagesPerMessage) } };
  }
  const totalBytes = existing.reduce((sum, item) => sum + (item.bytes ?? 0), 0) + file.size;
  if (totalBytes > l.maxMessageImageBytes) {
    return { key: "attach.tooLarge", params: { name: file.name || "image", limit: formatBytes(l.maxMessageImageBytes) } };
  }
  return null;
}

export async function fileToContentPart(file) {
  const data = await readAsBase64(file);
  return { type: "image", mediaType: file.type, data, name: file.name };
}

/// 把 ArrayBuffer 转成 base64。分块展开,避免 String.fromCharCode(...bytes)
/// 一次性展开整个文件 —— 大文件会把参数列表撑爆(栈溢出)且内存峰值翻倍。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32768 字节/块,展开参数数远低于引擎上限
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

async function readAsBase64(file) {
  // 测试环境无 FileReader 时走 arrayBuffer 兜底。
  if (typeof FileReader === "undefined") {
    const buffer = await file.arrayBuffer();
    return arrayBufferToBase64(buffer);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // 用 indexOf + slice 代替 split(","):split 会额外分配一个字符串数组。
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      resolve(comma === -1 ? dataUrl : dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error(t("attach.readFailed")));
    reader.readAsDataURL(file);
  });
}

export function createAttachmentTray({ uploadFile } = {}) {
  const pending = [];
  const listeners = new Set();
  // 文件的本机路径(setPath)。pasteboard 回包可能早于该文件的占位入列(逐个上传),
  // 所以按 File 记下,占位创建时再领。
  const knownPaths = new WeakMap();
  // 由 app 层在 imageLimits 投影到达时注入;未注入时用保守兜底。
  let limits = null;
  const emit = () => {
    const snapshot = pending.slice();
    for (const listener of listeners) listener(snapshot);
  };
  function drop(slot) {
    const at = pending.indexOf(slot);
    if (at === -1) return false;
    const [removed] = pending.splice(at, 1);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    return true;
  }
  function i18nError(key, params) {
    const error = new Error(key);
    error.i18nKey = key;
    error.i18nParams = params;
    return error;
  }
  function isBusy(item) { return !item.part && item.upload !== "failed"; }
  // UI 显示:文件(上传中/失败/就绪)都显示;图片只显示已读入的(占位毫秒级,不画)。
  // remove/retry 的 index 都按这个序列,与 render 的 data-index 一致。
  function visibleItems() { return pending.filter((item) => item.kind === "file" || item.part); }

  async function addImageRaw(file) {
    const rejection = validateImage(file, limits, pending.filter((item) => item.kind === "image"));
    if (rejection) throw i18nError(rejection.key, rejection.params);
    // 先按 bytes 占位再读文件。校验读 pending 是同步的,而读文件是异步的:
    // 不占位的话,一次粘贴多张图产生的并发调用会全部在 pending 仍为空时通过
    // 校验,张数与总字节上限双双被突破。
    const slot = { part: null, previewUrl: null, bytes: file.size, name: file.name, kind: "image", upload: "ready", file, path: knownPaths.get(file) ?? null };
    pending.push(slot);
    emit();
    let part;
    try {
      part = await fileToContentPart(file);
    } catch (error) {
      drop(slot);
      emit();
      throw error;
    }
    // clear() 可能在读取期间消费了整条草稿。已撤销的占位不能在异步读取
    // 完成后复活,更不能创建一个没有任何引用可供 revoke 的 Blob URL。
    if (!pending.includes(slot)) return;
    slot.part = part;
    slot.previewUrl = URL.createObjectURL(file);
    emit();
  }

  async function uploadRaw(slot) {
    slot.upload = "uploading";
    emit();
    try {
      const value = await uploadFile(slot.file);
      if (!pending.includes(slot)) return;   // 上传期间整条被清掉
      slot.part = { type: "file", receiptId: value.receiptId };
      slot.upload = "ready";
      emit();
    } catch (error) {
      if (!pending.includes(slot)) return;
      slot.upload = "failed";
      emit();
      throw error;
    }
  }

  async function addFileRaw(file) {
    if (typeof uploadFile !== "function") throw i18nError("attach.noUpload", {});
    const slot = { part: null, previewUrl: null, bytes: file.size, name: file.name, kind: "file", upload: "uploading", file, path: knownPaths.get(file) ?? null };
    pending.push(slot);
    emit();
    await uploadRaw(slot);
  }

  return {
    // 发送层只吃已就绪的 part。张数/字节校验读内部的 pending(含占位),
    // 所以上限依然按占位算。
    get pending() { return pending.filter((item) => item.part); },
    // render 层要看全貌:读图占位、上传中、失败都要展示。
    get all() { return pending.slice(); },
    get visible() { return visibleItems(); },
    // 读图/上传未完成时不能发送;失败不阻断(文字可单独发)。
    get reading() { return pending.some(isBusy); },
    get limits() { return limits; },
    setLimits(next) { limits = next ?? null; },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /// 抛出的错误带 i18nKey/i18nParams,让调用方用当前语言渲染。
    async addFile(file) {
      const mediaTypes = limits?.mediaTypes ?? FALLBACK_LIMITS.mediaTypes;
      return mediaTypes.includes(file.type) ? addImageRaw(file) : addFileRaw(file);
    },
    /// 记下文件在本机的绝对路径(拖入/从访达粘贴时由 native host 读 pasteboard 得到),
    /// 点胶囊时据此用默认应用打开。可早于或晚于该文件入列。
    setPath(file, path) {
      if (!file || typeof file !== "object" || typeof path !== "string" || !path) return false;
      knownPaths.set(file, path);
      const slot = pending.find((item) => item.file === file);
      if (slot) slot.path = path;
      return true;
    },
    /// 重试一次失败的上传,原始 File 仍被持有。
    async retry(index) {
      const target = visibleItems()[index];
      if (!target || target.kind !== "file" || target.upload !== "failed" || !target.file) return;
      await uploadRaw(target);
    },
    remove(index) {
      // 索引来自 DOM 的 data-index(与 render 同按 visible 渲染),重渲染竞态或被改写
      // 时可能是 NaN / 负数 / 越界。splice 对这些值另有语义(-1 删最后一个、NaN 当 0)。
      // 以 visible 为基准,失败/上传中的文件项也能移除。对齐 element-picker.remove。
      const list = visibleItems();
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
      drop(list[index]);
      emit();
    },
    clear() {
      for (const { previewUrl } of pending) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      }
      pending.length = 0;
      emit();
    }
  };
}

/// 胶囊本体可点开(onOpen):图片进查看器,文件用默认应用 / 新标签页打开。
/// 移除、重试两颗小按钮优先,不触发打开。
export function renderAttachmentTray(container, attachments, { onRemove, onRetry, onOpen } = {}) {
  container.innerHTML = attachments.map((attachment, index) => {
    const remove = `<button type="button" class="icon-btn" data-index="${index}" aria-label="${escapeHtml(t("attach.remove"))}">${lucideIconSvg("x", { size: 12 })}</button>`;
    const name = escapeHtml(attachment.name || "");
    const openLabel = escapeHtml(t("turn.openFile", { name: attachment.name || "" }));
    if (attachment.kind === "image") {
      const src = attachment.previewUrl ? ` src="${attachment.previewUrl}"` : "";
      return `<div class="attachment-chip image" data-open="${index}">`
        + `<button type="button" class="attachment-open" aria-label="${openLabel}" title="${name}"><img${src} alt="${name}"></button>`
        + `${remove}</div>`;
    }
    const status = attachment.upload === "failed" ? "failed" : attachment.upload === "uploading" ? "uploading" : "ready";
    const retry = attachment.upload === "failed" && onRetry
      ? `<button type="button" class="icon-btn" data-retry="${index}" aria-label="↻">↻</button>`
      : "";
    const label = attachment.upload === "uploading" ? "…" : "";
    return `<div class="attachment-chip file ${status}" data-open="${index}">`
      + `<button type="button" class="attachment-open file-name" aria-label="${openLabel}" title="${name}">${name}</button>`
      + label + retry + remove + `</div>`;
  }).join("");
  container.onclick = (event) => {
    const retry = event.target.closest("button[data-retry]");
    if (retry) { onRetry?.(Number(retry.dataset.retry)); return; }
    const button = event.target.closest("button[data-index]");
    if (button) { onRemove?.(Number(button.dataset.index)); return; }
    const chip = event.target.closest("[data-open]");
    if (chip && container.contains(chip)) onOpen?.(Number(chip.dataset.open));
  };
}
