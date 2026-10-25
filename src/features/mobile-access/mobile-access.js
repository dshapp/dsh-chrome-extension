// 移动端访问:配对与设备管理全部在 dsh 的 mobile-bridge 插件里,这里只是它的
// 一层视图状态 —— 没有子进程、没有状态文件、没有本地计时器。逐条对齐 Mac 的
// MobileAccessSupervisor(dsh-macapp/Sources/DSHMacKit/Server/MobileAccess)。
//
// 配对码的存活、设备在不在线都以桥接为准:码被手机扫走或过期后桥接就不再报它,
// 这一端只靠轮询 status 跟上,不自己倒计时。
import { RPC } from "../../platform/dsh/rpc-methods.js";

/// 移动端访问依赖的插件包名。
export const MOBILE_BRIDGE_PLUGIN = "dsh-mobile-bridge";

/// loading:还没读到;ready:桥接在;missing:插件没装(路由不存在);failed:别的错。
export const MobilePhase = Object.freeze({
  loading: "loading",
  ready: "ready",
  missing: "missing",
  failed: "failed"
});

/// 这条路由不存在 —— 插件没装,或桥接还在讲更老的一套。和"出错了"是两回事。
///
/// 宿主对没人注册的 /api/<ns>/<method> 有几种说法(RPC 信封里的 endpoint-unknown /
/// not-found,或干脆 HTTP 404),Mac 只认 "not found" 字样;这里把几种都收下。
export function isMissingRoute(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error ?? "");
  if (/unknown|not[-_ ]?found/i.test(code)) return true;
  return /not[-_ ]?found|unknown (method|endpoint)|endpoint[-_ ]unknown|HTTP 404/i.test(message);
}

/// status 回包 → 视图字段。老桥接缺的字段按 Mac 的口径补默认值:
/// disabled 缺 = 没切断,online 缺 = 离线,pairing 缺 ≠ pairing:null(见 reportsPairing)。
export function normalizeStatus(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const host = typeof value.proxyHost === "string" ? value.proxyHost : "";
  const port = Number.isFinite(value.proxyPort) ? value.proxyPort : null;
  const pairing = value.pairing && typeof value.pairing.url === "string" ? value.pairing : null;
  return {
    connected: value.connected === true,
    disabled: value.disabled === true,
    relay: host ? (port === null ? host : host + ":" + port) : "",
    deviceName: typeof value.deviceName === "string" ? value.deviceName : "",
    // 老桥接压根没有 pairing 字段:它的"没提"和新桥接的"没有了"不是一回事。
    reportsPairing: Object.prototype.hasOwnProperty.call(value, "pairing"),
    pairing,
    devices: (Array.isArray(value.devices) ? value.devices : [])
      .filter((device) => device && typeof device.deviceId === "string")
      .map((device) => ({
        deviceId: device.deviceId,
        label: typeof device.label === "string" && device.label ? device.label : device.deviceId,
        addedAt: Number(device.addedAt) || 0,
        lastSeenAt: Number(device.lastSeenAt) || 0,
        expiresAt: Number(device.expiresAt) || 0,
        online: device.online === true
      }))
  };
}

/// @param connection    dsh-connection,提供 call(method, args)。
/// @param pluginManager plugin-manager-service(装插件用),可缺省 —— 缺省时不提供安装。
/// @param onChange      状态变了就回调一次,由界面决定重画什么。
export function createMobileAccess({ connection, pluginManager, onChange } = {}) {
  const state = {
    phase: MobilePhase.loading,
    error: "",
    devices: [],
    connected: false,
    disabled: false,
    relay: "",
    deviceName: "",
    pairingUrl: null,
    installing: false,
    installError: ""
  };
  // 轮询与按钮触发的 refresh 会交错;只认最后发出的那一次,免得慢的旧回包盖掉新状态。
  let refreshSeq = 0;
  const emit = () => onChange?.(state);

  function fail(error) {
    if (isMissingRoute(error)) {
      state.phase = MobilePhase.missing;
      state.error = "";
    } else {
      state.phase = MobilePhase.failed;
      state.error = messageOf(error);
    }
  }

  /// 拉一次全量视图。
  async function refresh() {
    const seq = ++refreshSeq;
    try {
      const status = normalizeStatus(await connection.call(RPC.mobileBridgeStatus, {}));
      if (seq !== refreshSeq) return;
      state.devices = status.devices;
      state.connected = status.connected;
      state.disabled = status.disabled;
      state.relay = status.relay;
      state.deviceName = status.deviceName;
      // 只有会报配对码的桥接才有资格把它清掉;老桥接不报,手里那张继续用。
      if (status.reportsPairing) state.pairingUrl = status.pairing?.url ?? null;
      state.phase = MobilePhase.ready;
      state.error = "";
    } catch (error) {
      if (seq !== refreshSeq) return;
      fail(error);
    }
    emit();
  }

  /// 动作的公共收尾:成功后重读全量视图;失败按 Mac 的口径改 phase。
  async function act(method, args) {
    try {
      const value = await connection.call(method, args);
      await refresh();
      return value;
    } catch (error) {
      fail(error);
      emit();
      return undefined;
    }
  }

  /// 生成一张新的一次性配对码(一码一设备,铸新码即作废旧码)。
  async function pair() {
    try {
      const pairing = await connection.call(RPC.mobileBridgePair, {});
      if (typeof pairing?.url === "string") state.pairingUrl = pairing.url;
      // 先把新码画出来,再去读全量(设备列表 / 中转状态)。
      emit();
      await refresh();
    } catch (error) {
      fail(error);
      emit();
    }
  }

  /// 给一台已配对的手机改显示名。失败**不动 phase** —— 别的设备还好好的,
  /// 没理由把整页打成"未安装插件"。
  /// @returns {outcome:"renamed"} | {outcome:"unsupported"}(老插件没有这条路由)
  ///        | {outcome:"failed", message}
  async function rename(deviceId, label) {
    try {
      const value = await connection.call(RPC.mobileBridgeRename, { deviceId, label });
      if (value?.renamed === false) return { outcome: "failed", message: "" };
      await refresh();
      return { outcome: "renamed" };
    } catch (error) {
      if (isMissingRoute(error)) return { outcome: "unsupported" };
      return { outcome: "failed", message: messageOf(error) };
    }
  }

  /// 一键装上插件并让它生效(对齐 Mac APIClient.enablePluginBundle:装过就启用,
  /// 没装就装)。宿主说要重启时交给 restart;之后重读状态并出一张码。
  /// restart 返回 false 表示这台机器上重启不了,此时留下 "restart-required",
  /// 由界面说成"重启服务后生效"。
  async function install({ restart } = {}) {
    if (state.installing || !pluginManager) return;
    state.installing = true;
    state.installError = "";
    emit();
    try {
      const bundles = await pluginManager.pluginBundles().catch(() => []);
      const bundle = (Array.isArray(bundles) ? bundles : []).find((entry) => entry?.name === MOBILE_BRIDGE_PLUGIN);
      const result = bundle?.installed
        ? await pluginManager.setBundleEnabled(MOBILE_BRIDGE_PLUGIN, true)
        : await pluginManager.installBundle(MOBILE_BRIDGE_PLUGIN, { requestId: "mobile-" + Date.now().toString(36) });
      if (result?.application === "failed" || result?.application === "cancelled") {
        state.installError = result.error?.diagnostic || result.packageResult?.output
          || result.error?.code || result.application;
        return;
      }
      if (result?.application === "restart-required") {
        const restarted = restart ? await restart() : false;
        if (restarted === false) {
          state.installError = "restart-required";
          return;
        }
      }
    } catch (error) {
      state.installError = messageOf(error);
      return;
    } finally {
      state.installing = false;
      emit();
    }
    await refresh();
    if (state.phase === MobilePhase.ready && !state.pairingUrl) await pair();
  }

  return {
    state,
    refresh,
    pair,
    rename,
    install,
    /// 切断与中转的连接:所有手机立刻失去访问,直到恢复。
    disconnect: () => act(RPC.mobileBridgeDisconnect, {}),
    /// 恢复被切断的中转连接。
    connect: () => act(RPC.mobileBridgeConnect, {}),
    /// 吊销一台设备,下次握手即失效。
    revoke: (deviceId) => act(RPC.mobileBridgeRevoke, { deviceId })
  };
}

function messageOf(error) {
  return String(error?.message || error || "");
}
