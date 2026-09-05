// 目标(goal)RPC。对齐 macos/.../Networking/RPCMethods.swift 的 goal.* 分组。
// 所有变更都需要携带当前 ref(id + revision),宿主用它做乐观并发控制。
import { RPC } from "../../platform/dsh/rpc-methods.js";

function refOf(goal) {
  if (!goal?.id) return null;
  return { id: goal.id, revision: goal.revision ?? 0 };
}

export function createGoalService(connection) {
  return {
    async create(sessionId, objective, maxGoalRounds) {
      const request = { objective, ...(maxGoalRounds ? { maxGoalRounds } : {}) };
      return connection.call(RPC.goalCreate, { agentId: sessionId, request });
    },
    async edit(sessionId, goal, objective, maxGoalRounds) {
      const ref = refOf(goal);
      if (!ref) return null;
      return connection.call(RPC.goalEdit, {
        agentId: sessionId, ref, request: { objective, ...(maxGoalRounds ? { maxGoalRounds } : {}) }
      });
    },
    async pause(sessionId, goal) {
      const ref = refOf(goal);
      if (!ref) return null;
      return connection.call(RPC.goalPause, { agentId: sessionId, ref });
    },
    async resume(sessionId, goal) {
      const ref = refOf(goal);
      if (!ref) return null;
      return connection.call(RPC.goalResume, { agentId: sessionId, ref });
    },
    async clear(sessionId, goal) {
      const ref = refOf(goal);
      if (!ref) return null;
      return connection.call(RPC.goalClear, { agentId: sessionId, ref });
    }
  };
}
