// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mountAttachmentControls } from "../src/app/sidepanel/composer-attachments.js";

describe("composer attachments", () => {
  it("formats attachment validation errors before showing the toast", async () => {
    document.body.innerHTML = `
      <input id="file" type="file">
      <textarea id="input"></textarea>
      <div id="preview"></div>
      <div id="overlay" hidden></div>`;
    const rejection = Object.assign(new Error("attach.badType"), {
      i18nKey: "attach.badType",
      i18nParams: { name: "notes.txt" }
    });
    const showToast = vi.fn();
    const formatError = vi.fn(() => "notes.txt:不支持的图片格式");
    const attachments = {
      pending: [],
      onChange: vi.fn(),
      addFile: vi.fn().mockRejectedValue(rejection),
      remove: vi.fn()
    };
    const fileInput = document.querySelector("#file");
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["text"], "notes.txt", { type: "text/plain" })]
    });

    const controls = mountAttachmentControls({
      elements: {
        fileInput,
        input: document.querySelector("#input"),
        previewStrip: document.querySelector("#preview"),
        dropOverlay: document.querySelector("#overlay"),
        dropOverlayHint: null
      },
      deps: { attachments },
      showToast,
      formatError,
      onChange: vi.fn()
    });
    fileInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(formatError).toHaveBeenCalledWith(rejection);
    expect(showToast).toHaveBeenCalledWith("notes.txt:不支持的图片格式");
    controls.destroyDropZone();
  });
});
