# DSH 0.2.1-alpha.2 升级适配验证

验证日期：2026-10-14（Asia/Shanghai）。本次为代码级适配；验证阶段未提交或推送，后续按用户要求提交代码。未安装真实 DSH、部署 daemon 或重启正在使用的服务。

## 已实现

- 聊天协议：保留原始项目 cwd，执行与历史路径采用实际工作目录；PTC meta/error、工具准备行及正式调用去重、内容大小、回合完成/停止/失败、成功用时和最终 reasoning 折叠。
- 目标：冷打开、状态变化及重连刷新 activation；active + disarmed 必须显式恢复，按钮与快捷键一致。
- external 子智能体：保留目录状态，禁用本地会话导航与历史读取。
- 设置：删除 modeSelectionEnabled；恢复只读预设 YAML；继承模型 reset 只 unset；配置字段保真；凭证独立只读与 derived ref 状态；广播刷新保留草稿及原 expectedRevision。
- 主区域：独立插件与自动化页面，隐藏聊天但保留会话与草稿；设置页插件 tab 为只读目录与管理入口；隐藏页面停止订阅与轮询。
- 插件：official 分组、精确 installTarget、包/组件详情、兼容性及精确版本豁免、原 requestId 安装恢复，不自动重复安装。
- 自动化：正确的 catalog/list/update/delete/history RPC；规则编辑、完整 expected、冲突保留草稿、删除确认、独占消息游标与投递记录提示；不杜撰 schedule/create。
- daemon：固定 @deepseek-ai/dsh 包，仅允许 latest/next/alpha 或严格精确 SemVer；保留 Origin、单飞与安全 argv 边界；更新不自动重启。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 扩展全量 npm test | **387/387 通过**，0 failed、0 skipped |
| Rust cargo test | **138/138 通过** |
| Rust cargo build --release | 通过；产物仅编译，未部署 |
| JS node --check 与两个仓库 git diff --check | 通过 |
| 真实 Chrome 实读与主页面导航 | 通过，连接当前 127.0.0.1:3080 alpha.2 宿主 |
| 真实 Chrome mock-backed 写交互 | **7 组通过**；真实配置写入/安装/重启均为 0 |
| 420×900 虚拟视口 | 插件、自动化主页面无横向溢出，聊天区正确隐藏 |

真实浏览器实读覆盖：官方插件目录、自动化 catalog、只读插件库存、只读预设 YAML、设置 tab 顺序、插件管理跳转、返回后聊天草稿保留及恢复。

浏览器写交互由[隔离 fixture 模块](<../tests/browser/alpha2-fixtures.js>)验证，直接挂载生产组件，但各组件获得独立 mock service/client，不替换真实连接或全局 fetch：

1. next/alpha/精确版本选择、安装完成状态与不自动重启。
2. 旧 daemon 能力协商，非 latest 渠道禁用。
3. 自动化编辑、取消、冲突保留与完整 expected。
4. 历史 exclusive before 消息游标及“投递不等于模型执行完成”提示。
5. 删除确认、隐藏订阅与 dispose。
6. 凭证只读和保留 dirty DOM 的 soft facts refresh。
7. 模型恢复继承值、unset ownership 与原 expectedRevision 保留。

测试 fixture 初期修正了等待安装动作结束、异步目标查询中控件暂时不存在、对象字段顺序及模型输入值观察方式；最终生产组件 mock 流程全部通过。

## 浏览器证据

- [插件主页面，420×900](<../.tmp-shots/upgrade-alpha2-plugins-20261014.png>)
- [自动化主页面，420×900](<../.tmp-shots/upgrade-alpha2-automations-20261014.png>)

截图为本机实读结果，不是伪造数据。它们属于本机临时证据，不随代码提交或上传；以上截图链接仅在本工作区可用。

## 明确边界与后续启用

1. **正在运行的 daemon 尚未替换。** 当前 Host Git 请求返回 HTTP 403，响应为 origin not authorized。现源码精确允许 APP 的固定扩展 Origin，但现用进程与源码策略不一致。未伪造 Origin、扩大白名单或重启进程来绕过它。因此真实 Host Git 功能不能声称端到端通过；执行目录与历史路径逻辑已由回归覆盖。
2. 新 daemon 的[release 产物](</Users/user/dshapp/dsh-chrome-control/daemon/target/release/chrome-daemon>)已编译，未复制到已安装 bundle、未启用。非 latest 的真实更新需后续明确部署并在合适维护窗口启用新进程。本次仅 mock 验证选择/安装交互，不进行真实 DSH 升级。
3. 插件通用 schema 表单只覆盖宿主 settings.describe 已暴露的基本字段，凭证/复合 schema 保守处理；本地 trusted renderSlot 是扩展侧 adapter，**不等价于所有官方 React companion 或第三方专属配置页**。未执行宿主返回的任意 JS，也不猜测组件配置命名空间。
4. 自动化历史仅证明持久化收件箱投递，不证明模型执行或业务脚本成功。

## 主要回归文件

- [聊天协议与竞态](<../tests/dsh-021-chat.spec.mjs>)
- [external 导航与显式恢复](<../tests/dsh-021-navigation.spec.mjs>)
- [管理页可见性与设置覆盖竞态](<../tests/main-surfaces.spec.mjs>)
- [设置广播与重连](<../tests/settings-notifications.spec.mjs>)
- [真实 schema 设置回归](<../tests/settings-alpha2.spec.mjs>)
- [插件兼容与安装恢复](<../tests/plugin-manager-alpha.spec.mjs>)
- [自动化协议、草稿与投递历史](<../tests/automations.spec.mjs>)
- [受限更新渠道](<../tests/host-update-channels.spec.mjs>)

## 重跑浏览器写交互

先按[extension-dev 指引](<../.agents/skills/extension-dev/SKILL.md>)重载同一个本地扩展并打开侧栏页面，从 list_pages 获得当前 pageId。对该页面调用 evaluate_script，执行以下函数；不需要真实更新或设置写入：

```javascript
async () => {
  const fixtures = await import(chrome.runtime.getURL('tests/browser/alpha2-fixtures.js'));
  return await fixtures.runAlpha2BrowserFixtures();
}
```
