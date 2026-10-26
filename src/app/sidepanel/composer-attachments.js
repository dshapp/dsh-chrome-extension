// 附件控件编排:文件选择、粘贴图片与预览条。附件本身的解析与上限由
// features/attachments 拥有,这里只负责 DOM 事件与重绘时机。
//
// 「添加图片」的入口不在这里:它是候选浮层(#trigger-menu)里的一行,
// 由 trigger-menu 选中后回调 pickImage()。这里只提供那个动作本身。
//
// 文件夹不上传:按绝对路径写进提示词。路径由 native host 读系统 pasteboard 得到
// (粘贴读剪贴板,拖放读拖拽板),见 features/attachments/folder-paths.js。
//
// 点胶囊打开:图片进查看器;文件有真实路径(拖入 / 从访达粘贴时同样读 pasteboard
// 拿到)就交宿主用默认应用打开,否则在新标签页里打开浏览器手上的那份字节,
// 见 features/attachments/open-attachment.js。
import {
  renderAttachmentTray, mountDropZone, hasFiles, hasText, partitionDropped,
  matchDirectoryPaths, pairPathsByName, insertFolderPaths, createAttachmentOpener
} from "../../features/attachments/index.js";
import { openImageViewer } from "../../features/chat/image-viewer.js";
import { openUrlInNewTab } from "../../features/chat/link-actions.js";
import { requestPasteboardPaths } from "../../platform/dsh/native-supervisor.js";
import { t } from "../../shared/i18n.js";

export function mountAttachmentControls({
  elements, deps, showToast, formatError = (error) => error?.message ?? String(error), onChange,
  root = document.body, pasteboardPaths = requestPasteboardPaths,
  openPath = (path) => deps.workspaces.openPath(path),
  opener = createAttachmentOpener({ openUrl: openUrlInNewTab }),
  viewImages = openImageViewer
}) {
  const visibleItems = () => deps.attachments.visible ?? deps.attachments.all ?? deps.attachments.pending ?? [];

  function render() {
    // visible 含失败/上传中的文件项与已读入图片;pending(已就绪)只供发送层。
    const items = visibleItems();
    renderAttachmentTray(elements.previewStrip, items, {
      onRemove: (index) => deps.attachments.remove(index),
      onRetry: (index) => { void deps.attachments.retry?.(index); },
      onOpen: (index) => { void openAttachment(index); }
    });
    // 已移走 / 已发出的文件,打开时建的 blob: URL 一并回收。
    opener.release(items.map((item) => item.file).filter(Boolean));
    onChange();
  }

  /// 点开第 index 枚胶囊(index 与 render 的 data-open 同按 visible 计)。
  async function openAttachment(index) {
    const item = visibleItems()[index];
    if (!item) return;
    if (item.kind === "image") {
      // 输入框里的几张图组成一组,查看器里可以 ← / → 切换。
      const images = [...elements.previewStrip.querySelectorAll(".attachment-chip.image img[src]")];
      const target = elements.previewStrip.querySelector(`.attachment-chip[data-open="${index}"] img[src]`);
      if (target) viewImages(images, Math.max(0, images.indexOf(target)));
      return;
    }
    if (item.path) {
      try {
        await openPath(item.path);
        return;
      } catch {
        // 路径失效(文件已被移走/改名)或宿主不可用:退回浏览器手上的字节。
      }
    }
    if (!item.file) return;
    try {
      const how = await opener.openInBrowser(item.file);
      if (how === "download") showToast(t("attach.openDownloaded", { name: item.name || item.file.name || "" }));
    } catch (error) {
      showToast(formatError(error));
    }
  }

  /// 拖入 / 从访达粘贴的非图片文件:读同一块 pasteboard 拿真实路径,供点开时用
  /// 默认应用打开。拿不到不提示 —— 点开时会退回浏览器内打开。图片不需要(进查看器)。
  async function attachPaths(files, board) {
    if (!board || !files.length || typeof deps.attachments.setPath !== "function") return;
    let reply;
    try {
      reply = await pasteboardPaths(board);
    } catch {
      return;
    }
    if (!reply?.ok) return;
    // 按名字核对:pasteboard 可能是旧的,对不上的宁可没有路径。
    pairPathsByName(files.map((file) => file.name), reply.paths).forEach((path, index) => {
      if (path) deps.attachments.setPath(files[index], path);
    });
  }

  async function addFiles(files, { board, others = [] } = {}) {
    // 先发起 pasteboard 读取:拖拽板/剪贴板随时会被下一次操作换掉。
    const paths = attachPaths(others, board);
    await addEach(files);
    await paths;
  }

  async function addEach(files) {
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
    if (images.length || others.length) void addFiles([...images, ...others], { board: "general", others });
    if (directories.length) void addDirectories(directories, "general", insertionPoint());
    if (opaque) showToast(t("attach.itemUnreadable"));
  });

  // 覆盖层文案走 i18n(HTML 里那份是无 JS 时的兜底)。
  if (elements.dropOverlayHint) elements.dropOverlayHint.textContent = t("attach.dropHint");

  // 拖放:与粘贴共用 partitionDropped、addFiles 与 addDirectories,只是换了个事件来源。
  // 文件夹读拖拽板;输入框没有焦点时路径接在草稿末尾。
  const dropZone = mountDropZone(root, {
    overlay: elements.dropOverlay,
    onFiles: (files) => {
      void addFiles(files, { board: "drag", others: files.filter((file) => !String(file.type).startsWith("image/")) });
    },
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
