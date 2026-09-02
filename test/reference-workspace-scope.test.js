// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSidepanelApp } from "../src/app/sidepanel/sidepanel-app.js";

// '@' 的文件候选走宿主 fileReferences/list,它只按 agentId 对应会话的 cwd 搜索
// (@deepseek-ai/dsh-file-reference: list(agent, query) 以 agent.session.header.cwd 为根),
// 没有任何 workspace/cwd 入参。所以要让 '@' 落在用户选的工作目录里,唯一的办法是
// 保证当前会话本身就属于那个目录 —— 启动恢复会话时必须服从工作目录选择。
const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");
let prevChrome;
beforeEach(() => {
  prevChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: "https://x.com" }]), get: vi.fn(),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() } },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, connect: vi.fn(() => ({
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } })) },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: {} }]) },
    storage: { local: { get: vi.fn().mockResolvedValue({ dsh_workspace_id: "w-panel" }), set: vi.fn().mockResolvedValue(), remove: vi.fn().mockResolvedValue() } }
  };
  const proto = window.HTMLElement.prototype;
  if (!proto.hidePopover) { proto.hidePopover=function(){}; proto.showPopover=function(){}; proto.togglePopover=function(){}; }
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i,"").replace(/<script[\s\S]*?<\/script>/g,"");
});
afterEach(() => { if (prevChrome===undefined) delete globalThis.chrome; else globalThis.chrome=prevChrome; });

function makeDeps({ sessions, workspaces, storedWorkspaceId }) {
  const snapshot = { sessionId:null,title:"",cwd:null,blank:true,running:false,nodes:[],todos:[],goal:null,
    tokenUsage:null,permissions:null,planMode:null,queue:[],jobs:[],pendingApproval:null,pendingQuestion:null,
    contextPressure:null,sessionStats:null,imageLimits:null,subagent:null,agentPreset:null };
  globalThis.chrome.storage = { local: {
    get: vi.fn().mockResolvedValue(storedWorkspaceId ? { dsh_workspace_id: storedWorkspaceId } : {}),
    set: vi.fn().mockResolvedValue(), remove: vi.fn().mockResolvedValue() } };
  return {
    DshStreamState:{CONNECTED:"connected",CONNECTING:"connecting",DISCONNECTED:"disconnected"},
    connection:{baseUrl:"http://x",streamState:"connected",ensureStarted:vi.fn().mockResolvedValue(),
      call: vi.fn(async (m) => m==="host.describe" ? { home:"/Users/user", cwd:"/Users/user" } : ({})), respond:vi.fn()},
    onFrame:vi.fn(),
    sessions:{ store:{toolCall:()=>null},
      listStore:{ get:()=>sessions, subagentDescendants:()=>({count:0,runningCount:0}), subagentChildren:()=>new Map()},
      onRuntimeChange:vi.fn(), getRuntimeSnapshot:()=>snapshot, handleMuxFrame:vi.fn(), handleHostFrame:vi.fn(),
      refreshList:vi.fn().mockResolvedValue(sessions), create:vi.fn().mockResolvedValue("new-1"),
      open:vi.fn().mockResolvedValue("new-1"), loadHistory:vi.fn().mockResolvedValue({}),
      prompt:vi.fn(),cancel:vi.fn(),fork:vi.fn(),updateQueue:vi.fn(),search:vi.fn().mockResolvedValue(null),
      archive:vi.fn(),listAgentPresets:vi.fn().mockResolvedValue({presets:[]}),selectAgentPreset:vi.fn()},
    models:{refresh:vi.fn().mockResolvedValue([])}, skills:{skills:[],refresh:vi.fn().mockResolvedValue([])},
    commands:{commands:[],refresh:vi.fn().mockResolvedValue([]),execute:vi.fn()},
    workspaces:{refresh:vi.fn().mockResolvedValue(workspaces)},
    references:{files:vi.fn().mockResolvedValue([]),sessions:vi.fn().mockResolvedValue([])},
    goals:{create:vi.fn(),edit:vi.fn(),pause:vi.fn(),resume:vi.fn(),clear:vi.fn()},
    attachments:{pending:[],clear:vi.fn(),onChange:vi.fn(),setLimits:vi.fn()},
    settings:{}, formatErrorDetails:(e)=>String(e?.message??e), setLang:vi.fn(), getLang:()=>"zh"
  };
}

async function bootAndTypeAt(d) {
  const app = createSidepanelApp(document, d);
  await app.start();
  await new Promise(r=>setTimeout(r,50));
  const input = document.querySelector("#input") ?? document.querySelector("textarea");
  input.value="@"; input.selectionStart=1;
  input.dispatchEvent(new Event("input",{bubbles:true}));
  await new Promise(r=>setTimeout(r,30));
  return app;
}

const HOME = { sessionId:"home-session", cwd:"/Users/user", updatedAt:2 };
const PANEL = { sessionId:"panel-session", cwd:"/Users/user/panel-repo", updatedAt:1 };
const WS_PANEL = { workspaceId:"w-panel", path:"/Users/user/panel-repo",
  title:"panel-repo", sessionIds:["panel-session"] };

describe("'@' 文件候选必须落在选中的工作目录", () => {
  it("选中项目目录时,不恢复更近的家目录会话(否则 '@' 列出 Applications/Desktop)", async () => {
    const d = makeDeps({ sessions:[HOME, PANEL], workspaces:[WS_PANEL], storedWorkspaceId:"w-panel" });
    const app = await bootAndTypeAt(d);
    expect(app.state.sessionId).toBe("panel-session");
    expect(d.references.files.mock.calls.at(-1)[0]).toBe("panel-session");
  });

  it("选中的工作目录下还没有会话时,新建一个,而不是借用别的目录的会话", async () => {
    const d = makeDeps({ sessions:[HOME], workspaces:[{ ...WS_PANEL, sessionIds:[] }], storedWorkspaceId:"w-panel" });
    const app = await bootAndTypeAt(d);
    expect(d.sessions.create).toHaveBeenCalled();
    expect(app.state.sessionId).not.toBe("home-session");
  });

  it("宿主没给 sessionIds 名单时按 cwd 回落过滤", async () => {
    const d = makeDeps({ sessions:[HOME, PANEL],
      workspaces:[{ workspaceId:"w-panel", path:"/Users/user/panel-repo", title:"panel-repo" }],
      storedWorkspaceId:"w-panel" });
    const app = await bootAndTypeAt(d);
    expect(app.state.sessionId).toBe("panel-session");
  });

  it("「全部」(没选具体目录)时保持原行为:恢复最近一个会话", async () => {
    const d = makeDeps({ sessions:[HOME, PANEL], workspaces:[WS_PANEL], storedWorkspaceId:null });
    const app = await bootAndTypeAt(d);
    expect(app.state.sessionId).toBe("home-session");
  });
});
