# 八项能力的最终交付形态与独立边界

> 本文件为已评审的形态规划快照。用户继续后05已进入Task 1，正式src/tests/runtime已开始建立；其余形态决定不变，当前实施状态见根capabilities.json。旧规划中的“待创建”不是当前文件清单。

更新：2026-11-04。状态：planned。本文件确定拟议交付形态，不表示可用的skill、MCP、plugin或profile已经交付。本轮交付目录与计划，不安装插件，不索引业务仓库；05的独立实验不构成正式实现。

共同约束见 [development-contract.md](development-contract.md)。历史调查、设计和评审从 [plugin-catalog.md](plugin-catalog.md) 进入；各模块以自己的 PLAN.md 为实施入口。实施顺序为05→07→08→06→03→04→02→01；08先做工作台框架与05/07接入，其余逐项加入，不要求先实现全部模块。

| 目录 | 主交付形态 | 内部职责 | 可选/后置 | 不采用的替代方式 |
|---|---|---|---|---|
| [01-browser-auth](../01-browser-auth/PLAN.md) | DSH Host/client plugin + browser provider | 同页操作、受保护bridge、本地认证注入、站点/任务隔离 | 使用说明skill；不同浏览器载体适配 | 用skill掩盖bridge故障，或外部投屏冒称复用内置页 |
| [02-remote-environment](../02-remote-environment/PLAN.md) | AutoEnv本地stdio MCP + 独立remote-env-test skill | SSH/Telnet、装包/测试/日志、持久会话、作业状态、按需GDB | DSH管理UI、跨Agent复用 | 用普通文本skill承担连接生命周期，或另写一套远端协议核心 |
| [03-session-management](../03-session-management/PLAN.md) | DSH Host/client plugin | 会话基础操作、受控回收恢复、明确范围的rewind、一致性通知 | 批量管理、完整文件回退需独立验收 | skill直接rm用户session目录；会话隐藏冒称物理删除 |
| [04-code-learning](../04-code-learning/PLAN.md) | 学习编排skill + Atlas CLI适配脚本 | 真实配置、证据阅读、单/多仓路径、解释/预测/核验/续读 | Serena导航、本地MCP、Viewer/DSH面板 | 重写Clang解析器，或把普通代码索引当学习完成 |
| [05-local-memory](../05-local-memory/PLAN.md) | DSH plugin（hooks+批准Provider）+ 本地store | 提炼/召回/纠错/预算/隔离/管理 | 跨Agent MCP、深记忆后端 | 第三方托管记忆或未经批准的额外接收方 |
| [06-local-diagrams](../06-local-diagrams/PLAN.md) | 图生成skill + 本地图编辑plugin，两个按需子模块 | 已有证据的讲解图、.drawio本地编辑 | Atlas自带Viewer足够则无需新增 | 强制双装或用图生成事实 |
| [07-context-management](../07-context-management/PLAN.md) | DSH上下文plugin | 只读观察优先，受控编辑/压缩另立操作 | 压缩模型适配 | 将context观察等同长期记忆，或UI隐藏等同模型遗忘 |
| [08-workbench-ui](../08-workbench-ui/PLAN.md) | 最小plugin bundle + 隔离profile | 单模块按需装配、冲突检测、版本锁 | 经过验证的额外子包 | 重写桌面外壳或默认全家桶 |

## 形态选择理由

DSH plugin适合必须挂接Host API、客户端页面、会话事件和Provider的能力；MCP适合独立工具服务与跨宿主连接；skill适合解释、使用顺序、判断和学习编排。三者可以协作，但文档指令不替代执行边界，MCP也不自动提供数据隔离。离线Viewer是本地产物，不等于安装了正式VSCode扩展。

01复用现成浏览器控制基础，先确认真实内置页/bridge；02保留AutoEnv协议和证据核心；03复用会话管理生命周期但修正危险删除/恢复语义；04复用H:/VSCODE_READER的Atlas而非开发新解析器。05优先验证原生记忆Provider复用和本地管理；06区分生成与编辑；07先观察后写；08只编排已经兼容的模块。

## 共同开发边界

- 当前已读安装包基线是DSH `0.2.1-rc.5`；实际运行实例/profile仍须未来确认。另一份`0.2.2-alpha.2`源码不能混用，宿主升级不是本轮许可。
- 每项使用自己的runtime、固定依赖、临时DSH_HOME/profile、fixtures及证据目录；共享合同只共享schema和语义，不共享活跃用户配置。依赖不足从批准离线物料准备，禁止自动下载或执行上游安装脚本。
- 当前无Git仓库与可安装实现。正式src、tests、SKILL.md、package/pyproject、脚本和运行时均按各PLAN后续交付；05/experiments中已有验证代码及明确的局部测试记录，不能转述为完整实现。计划命令不代表已执行；本轮不擅自git init。
- 测试分两层：fakes/fixture保证本模块独立；隔离真实Host/协议/浏览器/Atlas测试才提供集成证据。fake通过不能宣传已修bridge、兼容DSH、已登陆内网或能分析真实驱动。
- 执行时按任务先失败测试、最小实现、通过验证，再进行独立评审。仅使用当前可用流程；本计划不要求不存在的superpowers子技能，也不因此阻止读计划。

## 能力间消息是可选协作，不是跨系统原子事务

拟议schema_version为1。03在本地会话/文件恢复有结果后记录持久outbox，供04/05按需消费；独立开发时用fixture事件模拟，不依赖真实对端。

```json
{
  "schema_version": 1,
  "kind": "workspace_files_restored",
  "source_capability": "03-session-management",
  "event_id": "unique-id",
  "session_ref": "fixture-session",
  "scope_ref": "registered-workspace",
  "operation_id": "fixture-operation",
  "generation": 1,
  "affected_refs": ["registered-relative-path-or-digest"],
  "before_snapshot": "snapshot-or-null",
  "after_snapshot": "snapshot-or-null",
  "outcome": "completed",
  "occurred_at": "ISO-8601"
}
```

`kind`为`session_surface_rewound/workspace_files_restored/session_removed`，`outcome`为`completed/partial/outcome_unknown`，snapshot字段可省略或为null。恢复未确认、消费者离线、重复或乱序消息均需可见；03重试投递，消费者按event_id幂等，不宣称日志、文件、Atlas索引和记忆存储同时提交。04收到相关事件先标stale，核对当前hash后重建；05冻结受影响来源的在途写入并按用户策略失效/保留，不自动删除无关记忆。失败时各模块保持保守状态，不把“没有收到事件”当数据仍新鲜。

字节字段、持久位置和验证规则最终以共同development-contract及各模块schema一致性测试为准；若出现冲突先对账，不让两个实现各自猜测。

## 本轮交付状态

已确定八项目录和拟议形态，各PLAN记录独立文件、接口、任务和验收。完整实现、协议接入、真机、网络出口与上游兼容测试均未完成；05局部实验结果单独记录。独立计划审查不等于部署准入。
