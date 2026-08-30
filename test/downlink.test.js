import { describe, it, expect } from "vitest";
import { parseDownlinkFrame } from "../src/platform/dsh/downlink.js";
import { createReconnectBackoff } from "../src/platform/dsh/reconnect-backoff.js";
import { mdToHtml, escapeHtml } from "../src/shared/md-to-html.js";

describe("downlink 帧解析", () => {
  it("ServerRequest 信封:method=payload.type", () => {
    const frame = parseDownlinkFrame(JSON.stringify({
      type: "server-request",
      rpcId: "r1",
      method: "session/subscribed",
      payload: { type: "session/subscribed", sessionId: "s1", lastSeq: 4 }
    }));
    expect(frame).toEqual({ rpcId: "r1", method: "session/subscribed", payload: { type: "session/subscribed", sessionId: "s1", lastSeq: 4 } });
  });

  it("非 server-request 或 method 不匹配返回 undefined", () => {
    expect(parseDownlinkFrame(JSON.stringify({ type: "server-response", rpcId: "r" }))).toBeUndefined();
    expect(parseDownlinkFrame(JSON.stringify({ type: "server-request", method: "a", payload: { type: "b" } }))).toBeUndefined();
    expect(parseDownlinkFrame("not json")).toBeUndefined();
  });
});

describe("reconnect backoff", () => {
  it("指数增长且封顶", () => {
    const backoff = createReconnectBackoff({ random: () => 0 });
    const delays = Array.from({ length: 7 }, () => backoff.next());
    expect(delays[0]).toBe(250);
    expect(delays[1]).toBe(500);
    expect(delays[2]).toBe(1000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(10000);
    backoff.reset();
    expect(backoff.next()).toBe(250);
  });
});

describe("md-to-html", () => {
  it("转义 HTML 注入", () => {
    expect(mdToHtml("<script>alert(1)</script>")).not.toContain("<script>");
    expect(escapeHtml('<a href="x">')).toBe("&lt;a href=&quot;x&quot;&gt;");
  });

  it("渲染标题/代码/列表/链接", () => {
    const html = mdToHtml("## Title\n\n- a\n- b\n\n`code`\n\n[link](https://example.com)");
    expect(html).toContain("<h4>Title</h4>");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });

  it("fenced code 原样转义", () => {
    const html = mdToHtml("```js\nconst x = \"<b>\";\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;b&gt;");
  });

  it("渲染表格:表头/分隔行/数据行,支持行内加粗", () => {
    const html = mdToHtml("| 名称 | 值 |\n| --- | --- |\n| a | **1** |\n| b | 2 |");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<thead><tr><th>名称</th><th>值</th></tr></thead>");
    expect(html).toContain("<td>a</td><td><strong>1</strong></td>");
    expect(html).toContain("<td>b</td><td>2</td>");
  });
});
