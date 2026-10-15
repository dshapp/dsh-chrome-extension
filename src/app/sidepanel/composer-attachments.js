// 附件控件编排:文件选择、粘贴图片与预览条。附件本身的解析与上限由
// features/attachments 拥有,这里只负责 DOM 事件与重绘时机。
//
// 「添加图片」的入口不在这里:它是候选浮层(#trigger-menu)里的一行,
// 由 trigger-menu 选中后回调 pickImage()。这里只提供那个动作本身。
//
// 文件夹不上传:按绝对路径写进提示词。路径由 native host 读系统 pasteboard 得到
// (粘贴读剪贴板,拖放读拖拽板),见 features/attachments/folder-paths.js。
import {
  renderAttachmentTray, mountDropZone, hasFiles, hasText, partitionDropped,
  matchDirectoryPaths, insertFolderPaths
} from "../../features/attachments/index.js";
import { requestPasteboardPaths } from "../../platform/dsh/native-supervisor.js";
import { t } from "../../shared/i18n.js";

export function mountAttachmentControls({
  elements, deps, showToast, formatError = (error) => error?.message ?? String(error), onChange,
  root = document.body, pasteboardPaths = requestPasteboardPaths
}) {
  function render() {
    // visible 含失败/上传中的文件项与已读入图片;pending(已就绪)只供发送层。
    renderAttachmentTray(elements.previewStrip, deps.attachments.visible ?? deps.attachments.all ?? deps.attachments.pending, {
      onRemove: (index) => deps.attachments.remove(index),
      onRetry: (index) => { void deps.attachments.retry?.(index); }
    });
    onChange();
  }

  async function addFiles(files) {
    for (const file of files) {
      try {
        await deps.attachments.addFile(file);
      } catch (error) {
        showToast(formatError(error));
      }
    }
  }

  /// 记下插入点。读 pasteboard 是异步的,期间用户若改了草稿,就退回到当时的光标处。
  function insertionPoint({ atEnd = false } = {}) {
    const input = elements.input;
    const end = input.value.length;
    return {
      value: input.value,
      start: atEnd ? end : input.selectionStart ?? end,
      end: atEnd ? end : input.selectionEnd ?? end
    };
  }

  /// 文件夹名 → 绝对路径 → 插进输入框。board:"general"(粘贴)或 "drag"(拖放)。
  async function addDirectories(names, board, point) {
    let reply;
    try {
      reply = await pasteboardPaths(board);
    } catch (error) {
      reply = { ok: false, reason: String(error?.message ?? error) };
    }
    if (!reply?.ok) {
      showToast(reply?.reason === "unknown-cmd"
        ? t("attach.folderPathHostOutdated")
        : t("attach.folderPathUnavailable", { name: names.join(", ") }));
      return;
    }
    const { matched, missing } = matchDirectoryPaths(names, reply.paths);
    if (missing.length) showToast(t("attach.folderPathUnavailable", { name: missing.join(", ") }));
    if (!matched.length) return;
    const input = elements.input;
    const unchanged = input.value === point.value;
    const start = unchanged ? point.start : input.selectionStart;
    const end = unchanged ? point.end : input.selectionEnd;
    const next = insertFolderPaths(input.value, start, end, matched);
    input.value = next.text;
    input.focus();
    input.setSelectionRange(next.caret, next.caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  deps.attachments.onChange(render);

  elements.fileInput.addEventListener("change", async () => {
    const files = [...(elements.fileInput.files ?? [])];
    elements.fileInput.value = "";
    await addFiles(files);
  });
  // 粘贴文件/文件夹:与拖放同一套分类(partitionDropped)和同一条入口。
  elements.input.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!hasFiles(data)) return;                       // 纯文本粘贴:完全不碰
    const { images, others, directories, opaque } = partitionDropped(data);
    if (!images.length && !others.length && !directories.length && !opaque) return;
    // Finder 拷贝文件:types 只有 "Files",但 Chrome 默认动作会把文件名插进输入框 —— 吃掉。
    // 带文字的混合内容(Excel/Word 等)保留默认的文字插入。
    if (!hasText(data)) event.preventDefault();
    if (images.length || others.length) void addFiles([...images, ...others]);
    if (directories.length) void addDirectories(directories, "general", insertionPoint());
    if (opaque) showToast(t("attach.itemUnreadable"));
  });

  // 覆盖层文案走 i18n(HTML 里那份是无 JS 时的兜底)。
  if (elements.dropOverlayHint) elements.dropOverlayHint.textContent = t("attach.dropHint");

  // 拖放:与粘贴共用 partitionDropped、addFiles 与 addDirectories,只是换了个事件来源。
  // 文件夹读拖拽板;输入框没有焦点时路径接在草稿末尾。
  const dropZone = mountDropZone(root, {
    overlay: elements.dropOverlay,
    onFiles: (files) => { void addFiles(files); },
    onDirectories: (names) => {
      const focused = document.activeElement === elements.input;
      void addDirectories(names, "drag", insertionPoint({ atEnd: !focused }));
    },
    onRejected: () => showToast(t("attach.itemUnreadable")),
    // 输入框禁用(会话未就绪/被交互卡接管)时不收,与发送键的禁用态一致。
    isEnabled: () => !elements.input.disabled
  });

  /// 唤起系统文件选择器。候选浮层的「添加图片」行走这里。
  function pickImage() {
    elements.fileInput.click();
  }

  return Object.freeze({ render, pickImage, destroyDropZone: dropZone.destroy });
}
