# 真实后端 E2E

这些脚本**不 mock 任何东西**:开真会话、开真 WebSocket 下行流、让真模型跑真 turn,
再用插件自己的 store / 交互逻辑去消费返回的数据。

单元测试锁的是"我以为的意图",这里锁的是"与宿主的实际契约"——
本次自测发现的 5 个线协议缺陷全部由这里暴露,单元测试一个都没抓到。

前置:`dsh web` 运行在 http://127.0.0.1:3080(可用环境变量 `DSH_BASE` 覆盖)。

```
node test/e2e/01-live-turn.mjs     # 事件归并、乱序/重放收敛、工具行、turnTail 指标
node test/e2e/02-interactions.mjs  # 审批 + 提问真实往返(应答必须被宿主 accepted)
node test/e2e/03-plan-mode.mjs     # /plan → 计划审阅 → 批准 → 自动退出
node test/e2e/04-plan-revise.mjs   # 带意见继续规划(批准与意见互斥的线协议)
node test/e2e/05-docks-and-session.mjs  # 目标生命周期、停靠区投影、预设、@引用、归档
```

耗时:每个脚本 1–5 分钟,取决于模型速度。

## 为什么这些用例值得保留

| 用例 | 锁住的契约 |
|---|---|
| 01 | 乱序事件必须插回窗口重折,不能丢弃 |
| 02 | 提问答案的 `custom` 为空时必须**省略字段**,不能发 `null` |
| 02 | 撤销应答的 `error.details` 是必填项 |
| 03/04 | 批准(`selected=[approve]`+无 custom)与意见(`custom` 单发)互斥 |
| 全部 | 斜杠命令走 `commands/execute` 且必须带 `images` |
| 05 | goal 变更必须带 `ref{id,revision}`,宿主据此做并发控制 |
| 05 | 附件上限取自 `imageLimits` 投影,不得写死 |
| 05 | `session.search` 在索引关闭的部署上必须优雅降级,不能报错 |
