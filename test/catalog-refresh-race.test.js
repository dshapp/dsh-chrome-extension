import { describe, expect, it, vi } from "vitest";
import { createModelService } from "../src/features/models/model-service.js";
import { createCommandService } from "../src/features/commands/command-service.js";
import { createSkillService } from "../src/features/skills/skill-service.js";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("共享目录刷新竞态", () => {
  it("模型目录只发布最后一次刷新结果", async () => {
    const old = deferred();
    const fresh = deferred();
    const service = createModelService({ call: vi.fn()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
    const published = [];
    service.subscribe((items) => published.push(items.map((item) => item.id)));
    const first = service.refresh();
    const second = service.refresh();
    fresh.resolve({ groups: [{ id: "p", models: [{ id: "new" }] }] });
    await second;
    old.resolve({ groups: [{ id: "p", models: [{ id: "old" }] }] });
    await first;
    expect(service.catalog.map((item) => item.id)).toEqual(["new"]);
    expect(published).toEqual([["new"]]);
  });

  it("命令列表不会被上一个会话的迟到回包覆盖", async () => {
    const old = deferred();
    const fresh = deferred();
    const service = createCommandService({ call: vi.fn()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
    const first = service.refresh("old-session");
    const second = service.refresh("new-session");
    fresh.resolve([{ name: "new" }]);
    await second;
    old.resolve([{ name: "old" }]);
    await first;
    expect(service.commands).toEqual([{ name: "new" }]);
  });

  it("技能列表不会被上一个会话的迟到回包覆盖", async () => {
    const old = deferred();
    const fresh = deferred();
    const service = createSkillService({ call: vi.fn()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
    const first = service.refresh("old-session");
    const second = service.refresh("new-session");
    fresh.resolve({ skills: [{ name: "new" }] });
    await second;
    old.resolve({ skills: [{ name: "old" }] });
    await first;
    expect(service.skills).toEqual([{ name: "new" }]);
  });

  it("切到空会话会使在途命令和技能响应失效", async () => {
    const commandGate = deferred();
    const skillGate = deferred();
    const commands = createCommandService({ call: vi.fn(() => commandGate.promise) });
    const skills = createSkillService({ call: vi.fn(() => skillGate.promise) });
    const commandLoad = commands.refresh("old");
    const skillLoad = skills.refresh("old");
    await commands.refresh(null);
    await skills.refresh(null);
    commandGate.resolve([{ name: "stale" }]);
    skillGate.resolve({ skills: [{ name: "stale" }] });
    await Promise.all([commandLoad, skillLoad]);
    expect(commands.commands).toEqual([]);
    expect(skills.skills).toEqual([]);
  });
});
