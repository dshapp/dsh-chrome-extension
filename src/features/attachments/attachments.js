// 图片附件:粘贴/选择文件 → prompt content 内联 base64(DSH 原生支持)。
//
// 限制以宿主的 imageLimits 投影为准(mediaTypes / maxImageBytes /
// maxImagesPerMessage / maxMessageImageBytes)。此前这里写死 10MB 与一份本地类型表,
// 与宿主实际的 20MB、20 张上限不一致:偏小会把宿主本可接受的图片拦下,
// 偏大则等到发送时才被宿主拒绝,而那时用户已经以为图片加好了。

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

/// 校验一个待加入的文件。返回 null 表示通过,否则返回人读的拒绝原因。
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

async function readAsBase64(file) {
  // 测试环境无 FileReader 时走 arrayBuffer 兜底。
  if (typeof FileReader === "undefined") {
    const buffer = await file.arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function createAttachmentTray() {
  const pending = [];
  const listeners = new Set();
  // 由 app 层在 imageLimits 投影到达时注入;未注入时用保守兜底。
  let limits = null;
  return {
    get pending() { return [...pending]; },
    get limits() { return limits; },
    setLimits(next) { limits = next ?? null; },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /// 抛出的错误带 i18nKey/i18nParams,让调用方用当前语言渲染。
    async addFile(file) {
      const rejection = validateImage(file, limits, pending);
      if (rejection) {
        const error = new Error(rejection.key);
        error.i18nKey = rejection.key;
        error.i18nParams = rejection.params;
        throw error;
      }
      const part = await fileToContentPart(file);
      pending.push({ part, previewUrl: URL.createObjectURL(file), bytes: file.size });
      for (const listener of listeners) listener(this.pending);
    },
    remove(index) {
      const [removed] = pending.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      for (const listener of listeners) listener(this.pending);
    },
    clear() {
      for (const { previewUrl } of pending) URL.revokeObjectURL(previewUrl);
      pending.length = 0;
      for (const listener of listeners) listener(this.pending);
    }
  };
}

export function renderAttachmentTray(container, attachments, { onRemove }) {
  container.innerHTML = attachments.map((attachment, index) => (
    `<div class="attachment-chip"><img src="${attachment.previewUrl}" alt="">`
    + `<button class="icon-btn" data-index="${index}">✕</button></div>`
  )).join("");
  container.onclick = (event) => {
    const button = event.target.closest("button[data-index]");
    if (button) onRemove(Number(button.dataset.index));
  };
}
