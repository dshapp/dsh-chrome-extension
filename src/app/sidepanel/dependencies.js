// DSH 侧栏应用组合根:组装各功能域依赖。纯组装,不含业务逻辑。
import { createSettings } from "../../platform/storage/settings.js";
import { createDshConnection, DshStreamState } from "../../platform/dsh/dsh-connection.js";
import { createSessionService } from "../../features/sessions/session-service.js";
import { createBackgroundNotifier } from "../../features/notifications/background-notifier.js";
import { createPendingSessionOpen } from "../../features/notifications/notification-click.js";
import { createModelService } from "../../features/models/model-service.js";
import { createSkillService } from "../../features/skills/skill-service.js";
import { createCommandService } from "../../features/commands/command-service.js";
import { createWorkspaceService } from "../../features/workspaces/workspace-service.js";
import { createReferenceService } from "../../features/references/reference-service.js";
import { createGoalService } from "../../features/goals/goal-service.js";
import { createAttachmentTray } from "../../features/attachments/attachments.js";
import { setLang, getLang } from "../../shared/i18n.js";
import { formatErrorDetails } from "../../shared/error-details.js";

export function createSidepanelDependencies(options = {}) {
  const settings = options.settings || createSettings();
  // 重连收敛回调依赖 sessions,而 sessions 又以 connection 为参数 —— 用 deferred
  // holder 打破组装顺序:回调在重连真正发生时读取 holder,那时 sessions 已就位。
  const lifecycle = {};
  const connection = options.connection || createDshConnection({
    settings,
    onGenerationReady: () => { void lifecycle.sessions?.resync?.(); }
  });
  // 后台会话失败提醒:service worker 的轮询只报"完成",失败细节只存在于
  // 被丢弃的 turn/end 帧里,所以由侧栏的帧偷看喂给系统通知。
  const notifier = options.notifier
    || createBackgroundNotifier({ notifications: globalThis.chrome?.notifications, settings });

  return Object.freeze({
    settings,
    connection,
    sessions: options.sessions || (lifecycle.sessions = createSessionService(connection, {
      onBackgroundTurnFailure: (sessionId, message) => notifier.reportFailure(sessionId, message)
    })),
    models: options.models || createModelService(connection),
    skills: options.skills || createSkillService(connection),
    commands: options.commands || createCommandService(connection),
    workspaces: options.workspaces || createWorkspaceService(connection),
    references: options.references || createReferenceService(connection),
    goals: options.goals || createGoalService(connection),
    // '@' 浮层的额外候选来源(可插拔契约,见 trigger-menu.js 的 extraSources)。
    mentionSources: options.mentionSources || [],
    attachments: options.attachments || createAttachmentTray(),
    // 通知点击的交接:worker 写 pending sessionId,侧栏领取后切会话。
    pendingSessionOpen: options.pendingSessionOpen || createPendingSessionOpen(),
    DshStreamState,
    formatErrorDetails,
    setLang,
    getLang,
    onFrame: (listener) => connection.onFrame(listener)
  });
}
