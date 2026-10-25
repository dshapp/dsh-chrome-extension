// 浏览器搜索的设置读写:对齐 Mac ChromeControlStore 的 Web search 段。
//
// 开关不是一个独立字段,而是 DSH web 服务的搜索后端选择 web.searchProvider:
// 选中 dsh-chrome-control 注册的 chrome-browser 即开启;关闭时删掉这项覆盖,
// 回到组合里的默认后端。引擎是插件 chrome-web-search 行的 engine 字段。
// 两者都是宿主的 volatile 设置,写完下一次搜索就生效,不用重启。

/// web 服务的设置命名空间(搜索后端选择)。
export const WEB_NAMESPACE = "web";
/// dsh-chrome-control 的网页搜索行。
export const WEB_SEARCH_NAMESPACE = "chrome-web-search";
/// 插件注册的搜索后端 id。
export const WEB_SEARCH_PROVIDER = "chrome-browser";
/// 可选引擎,顺序即下拉顺序;默认谷歌。
export const WEB_SEARCH_ENGINES = Object.freeze(["google", "bing", "baidu", "sogou", "toutiao"]);

/// 从 describe 的命名空间表读出当前状态;任一命名空间缺席(插件太旧或未加载)返回 null。
export function readWebSearchSettings(namespaces) {
  const web = namespaces?.get?.(WEB_NAMESPACE);
  const row = namespaces?.get?.(WEB_SEARCH_NAMESPACE);
  if (!web || !row) return null;
  const engine = row.value?.engine;
  return {
    enabled: web.value?.searchProvider === WEB_SEARCH_PROVIDER,
    engine: WEB_SEARCH_ENGINES.includes(engine) ? engine : "google"
  };
}

/// 开/关对应的 web 命名空间路径操作。
export function webSearchToggleOps(enabled) {
  return enabled
    ? [{ op: "set", path: ["searchProvider"], value: WEB_SEARCH_PROVIDER }]
    : [{ op: "unset", path: ["searchProvider"] }];
}

/// 选引擎对应的 chrome-web-search 命名空间路径操作。
export function webSearchEngineOps(engine) {
  if (!WEB_SEARCH_ENGINES.includes(engine)) throw new RangeError(`unknown search engine: ${engine}`);
  return [{ op: "set", path: ["engine"], value: engine }];
}
