import { describe, it, expect, vi } from "vitest";
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

  // renderAttachmentTray 用 Number(dataset.index) 取索引,DOM 被改写或重渲染
  // 竞态下可能得到 NaN / 负数 / 越界值。splice 对这些值有自己的语义:
  // -1 删最后一个、NaN 当 0 删第一个 —— 删掉的都不是用户点的那张,
  // 而真正想删的那张 blob 还留着没回收。同仓 element-picker 的 remove 有护栏。
  it("remove 的非法索引不误删,也不通知", async () => {
    const tray = createAttachmentTray();
    tray.setLimits({ mediaTypes: ["image/png"], maxImageBytes: 1e9, maxImagesPerMessage: 9, maxMessageImageBytes: 1e9 });
    const png = (name) => new File([new Uint8Array([1])], name, { type: "image/png" });
    await tray.addFile(png("a.png"));
    await tray.addFile(png("b.png"));

    let notified = 0;
    tray.onChange(() => { notified += 1; });
    for (const bad of [-1, NaN, 99, 2, undefined, 1.5]) tray.remove(bad);
    expect(tray.pending.map((p) => p.part.name)).toEqual(["a.png", "b.png"]);
    expect(notified).toBe(0);

    // 合法索引照常生效
    tray.remove(0);
    expect(tray.pending.map((p) => p.part.name)).toEqual(["b.png"]);
    expect(notified).toBe(1);
  });

  // 校验读 pending 是同步的,而写入在 await fileToContentPart 之后 —— 并发
  // 粘贴多张图时,所有调用都在 pending 仍为空时通过了校验。
  it("并发 addFile 不突破张数上限", async () => {
    const tray = createAttachmentTray();
    tray.setLimits({ mediaTypes: ["image/png"], maxImageBytes: 1e9, maxImagesPerMessage: 2, maxMessageImageBytes: 1e9 });
    const png = (name) => new File([new Uint8Array([1])], name, { type: "image/png" });
    const results = await Promise.allSettled(
      ["a", "b", "c", "d", "e"].map((n) => tray.addFile(png(`${n}.png`)))
    );
    expect(tray.pending).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
  });

  it("并发 addFile 不突破总字节上限", async () => {
    const tray = createAttachmentTray();
    tray.setLimits({ mediaTypes: ["image/png"], maxImageBytes: 1e9, maxImagesPerMessage: 20, maxMessageImageBytes: 100 });
    const big = (name) => {
      const file = new File([new Uint8Array([1])], name, { type: "image/png" });
      Object.defineProperty(file, "size", { value: 60 });
      return file;
    };
    await Promise.allSettled(["a", "b", "c", "d", "e"].map((n) => tray.addFile(big(`${n}.png`))));
    const total = tray.pending.reduce((sum, p) => sum + p.bytes, 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("读取乱序时 remove 的索引对应 UI 可见附件", async () => {
    vi.stubGlobal("FileReader", undefined);
    const tray = createAttachmentTray();
    tray.setLimits({ mediaTypes: ["image/png"], maxImageBytes: 1e9, maxImagesPerMessage: 9, maxMessageImageBytes: 1e9 });
    const reads = new Map();
    const delayed = (name) => {
      const file = new File([new Uint8Array([0])], name, { type: "image/png" });
      Object.defineProperty(file, "arrayBuffer", {
        value: () => new Promise((resolve) => reads.set(name, resolve))
      });
      return file;
    };
    const first = tray.addFile(delayed("slow.png"));
    const second = tray.addFile(delayed("fast.png"));
    reads.get("fast.png")(new Uint8Array([2]).buffer);
    await second;

    expect(tray.pending.map((item) => item.part.name)).toEqual(["fast.png"]);
    tray.remove(0);
    expect(tray.pending).toEqual([]);

    reads.get("slow.png")(new Uint8Array([1]).buffer);
    await first;
    expect(tray.pending.map((item) => item.part.name)).toEqual(["slow.png"]);
    vi.unstubAllGlobals();
  });

  it("读取期间 clear 后不创建游离的预览 URL", async () => {
    vi.stubGlobal("FileReader", undefined);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const tray = createAttachmentTray();
    let finishRead;
    const file = new File([new Uint8Array([0])], "late.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => new Promise((resolve) => { finishRead = resolve; })
    });

    const adding = tray.addFile(file);
    tray.clear();
    finishRead(new Uint8Array([1]).buffer);
    await adding;

    expect(tray.pending).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
    vi.unstubAllGlobals();
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
