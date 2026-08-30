// 侧栏薄入口:组装依赖并启动。
import { createSidepanelDependencies } from "../app/sidepanel/dependencies.js";
import { createSidepanelApp } from "../app/sidepanel/sidepanel-app.js";
import { initTheme } from "../app/sidepanel/theme.js";
import { setLang } from "../shared/i18n.js";

initTheme();

const deps = createSidepanelDependencies();
deps.settings.getLang().then(setLang);

const app = createSidepanelApp(document.documentElement, deps);
app.start().catch((error) => {
  console.error("[codemax-dsh] 启动失败", error);
  const banner = document.querySelector("#connection-banner");
  if (banner) {
    banner.textContent = `启动失败: ${error.message}`;
    banner.className = "connection-banner err";
  }
});
