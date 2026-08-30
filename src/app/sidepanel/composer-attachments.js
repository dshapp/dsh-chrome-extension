// 附件控件编排:加号菜单、文件选择、粘贴图片与预览条。附件本身的解析与上限由
// features/attachments 拥有,这里只负责 DOM 事件与重绘时机。
import { renderAttachmentTray } from "../../features/attachments/index.js";

export function mountAttachmentControls({ elements, deps, showToast, onChange }) {
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

  elements.attachBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.attachMenu.classList.toggle("open");
  });
  elements.attachImg.addEventListener("click", () => {
    elements.attachMenu.classList.remove("open");
    elements.fileInput.click();
  });
  elements.fileInput.addEventListener("change", async () => {
    const files = [...(elements.fileInput.files ?? [])];
    elements.fileInput.value = "";
    await addFiles(files);
  });
  elements.input.addEventListener("paste", (event) => {
    addFiles([...(event.clipboardData?.files ?? [])]);
  });
  document.addEventListener("click", (event) => {
    if (!elements.attachMenu.contains(event.target) && event.target !== elements.attachBtn) {
      elements.attachMenu.classList.remove("open");
    }
  });

  return Object.freeze({ render });
}
