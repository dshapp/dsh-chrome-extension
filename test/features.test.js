import { describe, it, expect } from "vitest";
import { fileToContentPart, validateImage, createAttachmentTray, formatBytes } from "../src/features/attachments/attachments.js";
import { flattenModelGroups, parseModelSelectValue, buildModelSelectOptions } from "../src/features/models/model-service.js";
import { applyFenceRules, FENCE_RULE_ID, rulesForBackendUrl } from "../src/platform/dsh/fence-rules.js";

describe("attachments", () => {
  it("文件转 base64 content part", async () => {
    const part = await fileToContentPart(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    expect(part).toMatchObject({ type: "image", mediaType: "image/png", name: "a.png" });
    expect(part.data).toBe("AQID");
  });

  it("限制以宿主 imageLimits 投影为准", () => {
    // 宿主实际下发 20MB;写死 10MB 会把宿主本可接受的图片拦下。
    const limits = { mediaTypes: ["image/png"], maxImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 20, maxMessageImageBytes: 200 * 1024 * 1024 };
    const big = new File([new Uint8Array(1)], "b.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 15 * 1024 * 1024 });
    expect(validateImage(big, limits, [])).toBeNull();
    // 同一张图在 10MB 上限下应被拒绝,证明限制确实来自投影。
    expect(validateImage(big, { ...limits, maxImageBytes: 10 * 1024 * 1024 }, []))
      .toMatchObject({ key: "attach.tooLarge" });
  });

  it("拒绝不支持的类型", () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    expect(validateImage(file, { mediaTypes: ["image/png"] }, []))
      .toMatchObject({ key: "attach.badType" });
  });

  it("拒绝超出每条消息的张数上限", () => {
    const limits = { mediaTypes: ["image/png"], maxImageBytes: 1e9, maxImagesPerMessage: 2, maxMessageImageBytes: 1e9 };
    const file = new File([new Uint8Array([1])], "c.png", { type: "image/png" });
    expect(validateImage(file, limits, [{ bytes: 1 }, { bytes: 1 }])).toMatchObject({ key: "attach.tooMany" });
  });

  it("拒绝超出单条消息总字节上限", () => {
    const limits = { mediaTypes: ["image/png"], maxImageBytes: 1e9, maxImagesPerMessage: 20, maxMessageImageBytes: 100 };
    const file = new File([new Uint8Array([1])], "d.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 60 });
    expect(validateImage(file, limits, [{ bytes: 60 }])).toMatchObject({ key: "attach.tooLarge" });
  });

  it("未收到投影时用保守兜底,不放行任意文件", () => {
    expect(validateImage(new File(["x"], "a.svg", { type: "image/svg+xml" }), null, []))
      .toMatchObject({ key: "attach.badType" });
  });

  it("tray 拒绝时抛出带 i18n key 的错误", async () => {
    const tray = createAttachmentTray();
    tray.setLimits({ mediaTypes: ["image/png"], maxImageBytes: 10, maxImagesPerMessage: 5, maxMessageImageBytes: 100 });
    const file = new File([new Uint8Array([1, 2, 3])], "e.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 50 });
    await expect(tray.addFile(file)).rejects.toMatchObject({ i18nKey: "attach.tooLarge" });
    expect(tray.pending).toHaveLength(0);
  });

  it("formatBytes 人读", () => {
    expect(formatBytes(20 * 1024 * 1024)).toBe("20MB");
    expect(formatBytes(512 * 1024)).toBe("512KB");
  });
});

describe("model-service", () => {
  it("分组展平与选择值解析", () => {
    const models = flattenModelGroups([
      { id: "deepseek", name: "DS", models: [{ id: "chat", name: "Chat" }] },
      { id: "pi", name: "PI", models: [{ id: "gpt", name: "GPT" }, { id: "claude", name: "Claude" }] }
    ]);
    expect(models).toHaveLength(3);
    expect(models[0].groupId).toBe("deepseek");
    expect(parseModelSelectValue("deepseek::chat")).toEqual({ provider: "deepseek", model: "chat" });
    expect(parseModelSelectValue("bad")).toBeNull();
    expect(buildModelSelectOptions(models, "pi", "gpt")).toContain("selected");
  });
});

describe("fence-rules", () => {
  it("生成 remove origin/sec-fetch-site 的 DNR 规则(regexFilter 匹配 authority)", async () => {
    const updates = [];
    const fakeDnr = {
      updateDynamicRules(payload) { updates.push(payload); return Promise.resolve(); }
    };
    await applyFenceRules(fakeDnr, "http://127.0.0.1:3080");
    expect(updates).toHaveLength(1);
    const rule = updates[0].addRules[0];
    expect(rule.id).toBe(FENCE_RULE_ID);
    expect(rule.action.requestHeaders.map((h) => h.header).sort()).toEqual(["origin", "sec-fetch-site"]);
    expect(rule.condition.regexFilter).toBe("^https?://127\\.0\\.0\\.1:3080/");
    expect(rule.condition.resourceTypes).toContain("websocket");
    expect(rule.condition).not.toHaveProperty("ports");
  });

  it("默认端口时 authority 允许端口省略", () => {
    const [rule] = rulesForBackendUrl("http://127.0.0.1");
    expect(rule.condition.regexFilter).toBe("^https?://127\\.0\\.0\\.1(?::\\d+)?/");
  });
});
