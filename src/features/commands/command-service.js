// 宿主斜杠命令(如 /compact /goal /permission):走 Typert Remote 通道,
// API client 会统一包一层 { args }；字段名是 agentId（不是 sessionId），与 skills/list 等
// legacy RPC 的 payload 形状不同,故不复用 skill-service 的调用方式。
export function createCommandService(connection) {
  let commands = [];
  let refreshGeneration = 0;
  return {
    get commands() { return commands; },
    async refresh(sessionId) {
      const generation = ++refreshGeneration;
      if (!sessionId) return commands;
      const value = await connection.call("commands/list", { agentId: sessionId });
      if (generation !== refreshGeneration) return commands;
      commands = value ?? [];
      return commands;
    },
    // line 是整行文本,如 "/compact" 或 "/goal 修复登录报错"。
    // 返回 undefined 表示 line 不是已注册的合法命令;否则 { commandId, result: { kind, text? } }。
    //
    // images 必须**始终携带**(无图片时为空数组)。Typert 网关按描述符逐字段校验,
    // 缺字段会整体拒绝并报 `args fields do not match the descriptor: missing "images"`,
    // 于是每一条斜杠命令都执行失败。Mac 端的 CommandExecutePayload 同样总是带上它。
    async execute(sessionId, line, images = []) {
      return connection.call("commands/execute", { agentId: sessionId, line, images });
    }
  };
}
