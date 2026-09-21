// 侧栏薄入口:组装依赖并启动。
import { createSidepanelDependencies } from "../app/sidepanel/dependencies.js";
import { createSidepanelApp } from "../app/sidepanel/sidepanel-app.js";
import { initTheme } from "../app/sidepanel/theme.js";
import { setLang, t } from "../shared/i18n.js";

// 主题偏好的读写在 app 里(deps.settings),但首帧颜色要在此之前就定下来,
// 否则冷启动会先闪一帧系统色再跳回用户选的那档。
const theme = initTheme();

const deps = createSidepanelDependencies();
const app = createSidepanelApp(document.documentElement, deps, { theme });

// 先取到语言偏好再启动:start() 会给静态 DOM 打首帧本地化,晚于 setLang 的
// 话英文偏好在启动时会被中文默认值盖住(要等用户再改一次语言才纠正)。
deps.settings.getLang()
  .then((lang) => setLang(lang))
  .catch(() => { /* 读不到偏好时保持默认中文 */ })
  .then(() => app.start())
  .catch((error) => {
    console.error("[dsh] 启动失败", error);
    const banner = document.querySelector("#connection-banner");
    if (banner) {
      banner.textContent = t("app.startFailed", { message: error.message });
      banner.className = "connection-banner err";
    }
  });
