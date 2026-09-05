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

/// 把 ArrayBuffer 转成 base64。分块展开,避免 `String.fromCharCode(...bytes)`
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
    // 只暴露读完的附件:占位项的 part 还是 null,漏出去会被拼进消息体发给宿主。
    // 张数/字节校验读的是内部的 pending(含占位),所以上限依然按占位算。
    get pending() { return pending.filter((item) => item.part); },
    // 读取期间不能发送：否则文字会先发出去，随后 clear() 消费占位，用户选中的
    // 图片被静默丢弃。单独暴露状态而不是把空 part 泄漏给消息构造层。
    get reading() { return pending.some((item) => !item.part); },
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
      // 先按 bytes 占位再读文件。校验读 pending 是同步的,而读文件是异步的:
      // 不占位的话,一次粘贴多张图产生的并发调用会全部在 pending 仍为空时通过
      // 校验,张数与总字节上限双双被突破,直到发送时才被宿主拒绝。
      const slot = { part: null, previewUrl: null, bytes: file.size };
      pending.push(slot);
      for (const listener of listeners) listener(this.pending);
      let part;
      try {
        part = await fileToContentPart(file);
      } catch (error) {
        const at = pending.indexOf(slot);
        if (at !== -1) pending.splice(at, 1);
        for (const listener of listeners) listener(this.pending);
        throw error;
      }
      // clear() 可能在读取期间消费了整条草稿。已撤销的占位不能在异步读取
      // 完成后复活，更不能创建一个没有任何引用可供 revoke 的 Blob URL。
      if (!pending.includes(slot)) return;
      slot.part = part;
      slot.previewUrl = URL.createObjectURL(file);
      for (const listener of listeners) listener(this.pending);
    },
    remove(index) {
      // 索引来自 DOM 的 data-index,重渲染竞态或被改写时可能是 NaN / 负数 / 越界。
      // splice 对这些值另有语义(-1 删最后一个、NaN 当 0),删掉的都不是用户点的
      // 那张,而目标那张的 blob 还留着没回收。对齐 element-picker.remove 的护栏。
      // UI 只渲染已读完的附件；读取中的占位仍在 pending 内，不能直接拿 UI
      // 索引去 splice，否则乱序完成时会删除另一张仍在读取的图片。
      const visible = pending.filter((item) => item.part);
      if (!Number.isInteger(index) || index < 0 || index >= visible.length) return;
      const target = visible[index];
      const at = pending.indexOf(target);
      if (at === -1) return;
      const [removed] = pending.splice(at, 1);
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
