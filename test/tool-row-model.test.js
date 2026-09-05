import { describe, it, expect, beforeAll } from "vitest";
import { toolRowModel, classifyTool, ToolVariant, planSummary, hasResultText } from "../src/features/chat/tool-row-model.js";
import { toolCallNode, toolResult, ToolRowState } from "../src/features/sessions/chat-nodes.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

function call(name, argsRaw, extra = {}) {
  return toolCallNode({ callId: "c1", name, argsRaw, turn: 1, step: 0, startSeq: 1, time: 1, ...extra });
}
function settle(node, result) {
  node.result = toolResult({ seq: 2, time: 2, ...result });
  return node;
}

describe("variant 分类", () => {
  it("精确匹配已知工具", () => {
    expect(classifyTool("bash")).toBe(ToolVariant.bash);
    expect(classifyTool("pwsh")).toBe(ToolVariant.bash);
    expect(classifyTool("web_search")).toBe(ToolVariant.search);
    expect(classifyTool("run_code")).toBe(ToolVariant.code);
  });
  it("cordis_bash 不误蹭 bash 规则", () => {
    expect(classifyTool("cordis_bash")).toBe(ToolVariant.others);
  });
});

describe("summary 派生", () => {
  it("bash 优先 description 再 command", () => {
    expect(toolRowModel(call("bash", '{"command":"ls -la","description":"列目录"}')).summary).toBe("列目录");
    expect(toolRowModel(call("bash", '{"command":"ls -la"}')).summary).toBe("ls -la");
  });
  it("只取首行", () => {
    // JSON 里的换行必须是转义的 \\n,否则整个参数串就不是合法 JSON。
    const args = JSON.stringify({ command: "line1\nline2" });
    expect(toolRowModel(call("bash", args)).summary).toBe("line1");
  });
  it("web_search 合并全部 query", () => {
    expect(toolRowModel(call("web_search", '{"queries":["a","b"]}')).summary).toBe("a, b");
  });
  it("read 取 file_path 并暴露 filePath", () => {
    const m = toolRowModel(call("read", '{"file_path":"/x/y.ts"}'));
    expect(m.summary).toBe("/x/y.ts");
    expect(m.filePath).toBe("/x/y.ts");
  });
  it("非文件类 variant 不给 filePath", () => {
    expect(toolRowModel(call("bash", '{"command":"ls"}')).filePath).toBeNull();
  });
  it("others 把工具名前缀进摘要", () => {
    expect(toolRowModel(call("my_tool", '{"x":"v"}')).summary).toBe("my_tool · v");
  });
  it("keyed 行不加工具名前缀", () => {
    const m = toolRowModel(call("exit_plan_mode", '{"plan":"P"}'));
    expect(m.summary).toBe("Awaiting review");
  });
  it("参数非法 JSON 时退化为原文首行", () => {
    expect(toolRowModel(call("bash", '{"command":"ls')).summary).toBe('{"command":"ls');
  });
  it("路径相对化与 home 缩写", () => {
    expect(toolRowModel(call("read", '{"path":"/w/a.ts"}'), { cwd: "/w" }).summary).toBe("a.ts");
    expect(toolRowModel(call("read", '{"path":"/Users/me/a.ts"}'), { home: "/Users/me" }).summary).toBe("~/a.ts");
  });
});

describe("状态判定", () => {
  it("未结算为 running", () => {
    expect(toolRowModel(call("bash", "{}")).state).toBe(ToolRowState.running);
  });
  it("isError 为 error 并给出错误首行", () => {
    const m = toolRowModel(settle(call("bash", "{}"), { isError: true, content: [{ type: "text", text: "boom\nmore" }] }));
    expect(m.state).toBe(ToolRowState.error);
    expect(m.errorSummary).toBe("boom");
  });
  it("interrupted 错误码为 stopped", () => {
    const m = toolRowModel(settle(call("bash", "{}"), { isError: true, error: { name: "Interrupted", code: "interrupted" } }));
    expect(m.state).toBe(ToolRowState.stopped);
  });
  it("终端非零退出码判为 error(尽管 isError 为 false)", () => {
    const m = toolRowModel(settle(call("bash", '{"command":"false"}'), {
      isError: false, content: [{ type: "text", text: "" }], resultView: { card: "terminal", exitCode: 1 }
    }));
    expect(m.state).toBe(ToolRowState.error);
  });
  it("终端信号终止同样判为 error", () => {
    const m = toolRowModel(settle(call("bash", "{}"), { isError: false, resultView: { card: "terminal", signal: "SIGKILL" } }));
    expect(m.state).toBe(ToolRowState.error);
  });
  it("退出码 0 保持 ok", () => {
    const m = toolRowModel(settle(call("bash", "{}"), { isError: false, resultView: { card: "terminal", exitCode: 0 } }));
    expect(m.state).toBe(ToolRowState.ok);
  });
});

describe("摘要替换优先级", () => {
  it("终端描述压过参数摘要", () => {
    const node = call("bash", '{"command":"ls"}', { callView: { card: "terminal", description: "列出文件" } });
    expect(toolRowModel(node).summary).toBe("列出文件");
  });
  it("搜索结果标题在结算后替换摘要", () => {
    const m = toolRowModel(settle(call("grep", '{"pattern":"x"}'), {
      isError: false, content: [], resultView: { card: "search", title: "12 处命中" }
    }));
    expect(m.summary).toBe("12 处命中");
  });
});

describe("verdict 阶梯", () => {
  it("todo 摘要给出完成计数与并行 suffix", () => {
    const args = JSON.stringify({ todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "in_progress" }
    ]});
    const m = toolRowModel(call("todo_write", args));
    expect(m.summary).toBe("1/3 completed · b");
    expect(m.summarySuffix).toBe("+1");
  });
  it("todo 无活跃项时不给 suffix", () => {
    const args = JSON.stringify({ todos: [{ content: "a", status: "completed" }] });
    const m = toolRowModel(call("todo_write", args));
    expect(m.summary).toBe("1/1 completed");
    expect(m.summarySuffix).toBeNull();
  });
  it("ask 未结算显示等待", () => {
    expect(toolRowModel(call("ask_user_question", "{}")).summary).toBe("waiting");
  });
  it("ask 结算显示已答计数", () => {
    const answers = JSON.stringify({ answers: [{ selected: ["y"] }, { selected: [] }] });
    const m = toolRowModel(settle(call("ask_user_question", "{}"), {
      isError: false, content: [{ type: "text", text: answers }]
    }));
    expect(m.summary).toBe("1/2 answered");
  });
  it("ask 被中止走 stopped 且具名", () => {
    const m = toolRowModel(settle(call("ask_user_question", "{}"), {
      isError: true, error: { name: "Ask", code: "ASK_ABORTED" }
    }));
    expect(m.state).toBe(ToolRowState.stopped);
    expect(m.summary).toBe("interrupted");
  });
  it("plan 未结算等待审阅,成功即批准", () => {
    expect(planSummary(call("exit_plan_mode", "{}"))).toBe("Awaiting review");
    expect(planSummary(settle(call("exit_plan_mode", "{}"), { isError: false, content: [] }))).toBe("Plan approved");
  });
  it("plan 出错返回 null,让错误首行接管", () => {
    const node = settle(call("exit_plan_mode", "{}"), { isError: true, content: [{ type: "text", text: "换个方向" }] });
    expect(planSummary(node)).toBeNull();
    expect(toolRowModel(node).errorSummary).toBe("换个方向");
  });
});

describe("output", () => {
  it("未结算无 output", () => {
    expect(toolRowModel(call("bash", "{}")).output).toBeNull();
  });
  it("结算后摊平文本块", () => {
    const m = toolRowModel(settle(call("bash", "{}"), { isError: false, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }));
    expect(m.output).toBe("a\nb");
  });
  it("空内容的失败回退到结构化错误行", () => {
    const m = toolRowModel(settle(call("bash", "{}"), { isError: true, content: [], error: { name: "E", code: "c1" } }));
    expect(m.output).toBe("E: c1");
  });

  it("折叠态只探测是否有输出，不会读取文本内容", () => {
    let reads = 0;
    const block = { type: "text" };
    Object.defineProperty(block, "text", { get() { reads += 1; return "large output"; } });
    const node = settle(call("bash", "{}"), { isError: false, content: [block] });
    const model = toolRowModel(node);
    expect(reads).toBe(0);
    expect(hasResultText(node.result)).toBe(true);
    expect(reads).toBe(1);
    expect(model.output).toBe("large output");
    expect(reads).toBe(2);
  });
});
