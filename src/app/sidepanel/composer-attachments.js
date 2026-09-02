// 附件控件编排:文件选择、粘贴图片与预览条。附件本身的解析与上限由
// features/attachments 拥有,这里只负责 DOM 事件与重绘时机。
//
// 「添加图片」的入口不在这里:它是候选浮层(#trigger-menu)里的一行,
// 由 trigger-menu 选中后回调 pickImage()。这里只提供那个动作本身。
import { renderAttachmentTray, mountDropZone } from "../../features/attachments/index.js";
import { t } from "../../shared/i18n.js";

export function mountAttachmentControls({ elements, deps, showToast, onChange, root = document.body }) {
  function render() {
    renderAttachmentTray(elements.previewStrip, deps.attachments.pending, {
      onRemove: (index) => deps.attachments.remove(index)
    });
    onChange();
  }

  async function addFiles(files) {
    for (const file of files) {
      try {
        await deps.attachments.addFile(file);
      } catch (error) {
        showToast(error.message);
      }
    }
  }

  deps.attachments.onChange(render);

  elements.fileInput.addEventListener("change", async () => {
    const files = [...(elements.fileInput.files ?? [])];
    elements.fileInput.value = "";
    await addFiles(files);
  });
  elements.input.addEventListener("paste", (event) => {
    addFiles([...(event.clipboardData?.files ?? [])]);
  });

  // 覆盖层文案走 i18n(HTML 里那份是无 JS 时的兜底)。
  if (elements.dropOverlayHint) elements.dropOverlayHint.textContent = t("attach.dropHint");

  // 拖放:与粘贴同一条路(addFiles),只是换了个数据来源。
  // 拖非图片/文件夹时给一句明确的话 —— 浏览器不给真实路径,那条需求要走 '@'。
  const dropZone = mountDropZone(root, {
    overlay: elements.dropOverlay,
    onFiles: (files) => { void addFiles(files); },
    onRejected: () => showToast(t("attach.dropNeedsImage")),
    // 输入框禁用(会话未就绪/被交互卡接管)时不收,与发送键的禁用态一致。
    isEnabled: () => !elements.input.disabled
  });

  /// 唤起系统文件选择器。候选浮层的「添加图片」行走这里。
  function pickImage() {
    elements.fileInput.click();
  }

  return Object.freeze({ render, pickImage, destroyDropZone: dropZone.destroy });
}
