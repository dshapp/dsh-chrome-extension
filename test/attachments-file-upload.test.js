// 非图片文件附件:走 session/uploadFileBinary 真上传,换回 receiptId。
// 覆盖:上传成功 / 失败保留可重试 / retry / 未注入 uploader 报错。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAttachmentTray } from "../src/features/attachments/attachments.js";

const pdf = (name = "a.pdf") => new File(["bytes"], name, { type: "application/pdf" });

describe("非图片文件上传", () => {
  beforeEach(() => {
    vi.stubGlobal("FileReader", undefined);
  });

  it("上传成功换回 file part(receiptId)", async () => {
    const uploadFile = vi.fn(async () => ({ receiptId: "receipt-1" }));
    const tray = createAttachmentTray({ uploadFile });
    await tray.addFile(pdf());
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(tray.pending.map((i) => i.part)).toEqual([{ type: "file", receiptId: "receipt-1" }]);
    expect(tray.reading).toBe(false);
  });

  it("上传失败保留为 failed,可重试成功", async () => {
    const uploadFile = vi.fn()
      .mockRejectedValueOnce(new Error("net down"))
      .mockResolvedValueOnce({ receiptId: "receipt-2" });
    const tray = createAttachmentTray({ uploadFile });
    await expect(tray.addFile(pdf())).rejects.toThrow("net down");
    // 失败不阻断发送(reading 只看 busy),也不进发送用的 pending。
    expect(tray.reading).toBe(false);
    expect(tray.pending).toEqual([]);
    // UI 仍可见,可重试。
    expect(tray.visible.length).toBe(1);
    expect(tray.visible[0].upload).toBe("failed");
    await tray.retry(0);
    expect(tray.pending.map((i) => i.part)).toEqual([{ type: "file", receiptId: "receipt-2" }]);
  });

  it("未注入 uploader 时抛 attach.noUpload", async () => {
    const tray = createAttachmentTray();
    await expect(tray.addFile(pdf())).rejects.toMatchObject({ i18nKey: "attach.noUpload" });
  });

  it("上传中 reading 为真,阻断发送", async () => {
    let release;
    const uploadFile = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const tray = createAttachmentTray({ uploadFile });
    const adding = tray.addFile(pdf());
    expect(tray.reading).toBe(true);
    expect(tray.pending).toEqual([]);   // 上传中无 part,不发
    release({ receiptId: "receipt-3" });
    await adding;
    expect(tray.reading).toBe(false);
    expect(tray.pending.length).toBe(1);
  });

  it("失败项可按 visible 索引移除", async () => {
    const uploadFile = vi.fn().mockRejectedValue(new Error("nope"));
    const tray = createAttachmentTray({ uploadFile });
    await expect(tray.addFile(pdf())).rejects.toThrow("nope");
    expect(tray.visible.length).toBe(1);
    tray.remove(0);
    expect(tray.visible).toEqual([]);
  });
});
