# 生态扩展与单/多仓代码学习方案

日期：2026-11-03。状态：`in_review`。设计与独立评审由不同 subagent 完成。本轮仅调查与设计，未安装、构建、索引私有代码、修改 H 盘仓库、运行 Atlas 或回退任何会话/文件。

调查证据集中于 [ecosystem-learning-research.md](ecosystem-learning-research.md)；既有底座见 [design.md](design.md) 与 [code-memory-design.md](code-memory-design.md)。本文件不改变既有文档摘要，不将项目 README 或历史测试报告当成本轮实测。

## 1. 范围归并与建议

| 用户候选/需求 | 归并类别 | 设计决定 |
|---|---|---|
| Eagle browser / 可能对应的Ego | #1 浏览器控制 | 用户未知链接；已发现Fisfzy/dsh-ego-browser，作为可能对应候选独立评估，不认定Eagle就是它 |
| Draw.io edit | 新组：图示编辑 | 评估原生 `.drawio` 编辑；离线本地编辑器是必要前提，不把图形当源码事实 |
| Archify | 新组：图示生成/呈现，与#4配合 | 从已核对关系生成可交互说明；优先Atlas自有离线HTML足够时不新增组件 |
| dsh context | 新组：上下文观察/控制 | 观察模型输入、预算、压缩与记忆注入，和长期记忆分开；先只读可视化 |
| rewind | #3 会话管理的受控回退子类 | 先消歧并审查会话回退/本地文件恢复范围，不能当远端环境回滚 |
| dsh web ui | 新组：UI外壳/聚合生态 | 评估具体子模块与版本，不整包默认启用工坊、下载、网络隧道及其他无关模块 |
| 专门学习单/多仓代码 | #4 从关系检索扩展到代码学习 | 优先复用本地 SDK Code Atlas v0.8 + 轻量学习编排 skill，按需使用Serena；不从头创建解析器 |

选型次序：先补学习流程，再按缺口增加图示、上下文与UI；浏览器和回退沿原有安全要求独立验收。上述候选尚未获得部署准入。身份未知不是否定候选，但不能先安装一个猜测同名项目。

### 调查快照与版本门禁

主调查实时manifest：Archify 3.2.0、根LICENSE与包manifest为Apache-2.0；Drawioedit 1.3.0包名为`@guowenzhang/dsh-drawioedit`；dsh-context 0.80.3。SiriLee `dsh-rewind-plugin` 0.20.0-alpha.4要求宿主`>=0.2.2-alpha.2 <0.3.0`，`dsh-web-all` 0.4.14的宿主peer为`>=0.2.2-alpha.3`，均不满足现装`0.2.1-rc.5`。不能绕过version gate直接试用，亦不为插件擅自升级宿主；未来可选验证旧兼容版本或独立升级计划，分别锁构件/迁移与回滚。

### Ego可能对应候选

[Fisfzy/dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser) 0.9.8/MIT是已发现项目，用户所说Eagle身份仍未知；旧`Fisfzy/ego-browser`不是可据以安装的地址。其独立Chromium与CLI提供ego_*工具，并以SSE画面流呈现在原生侧栏；这不证明它复用官方内置页或修复原bridge。登录态扩展配对/复制cookie、持久profile、wrapper的`--no-sandbox`、ffmpeg按需下载和冷启动诊断均需审计，不能从本地画面流推断无外发或隔离完整。按原#1同页要求、秘密不入模型及指定origin策略单独验收；若选择投屏替代，需明确这是不同载体取舍。

## 2. 统一边界

用户允许 Agent 使用既有批准模型 API（可公网）完成常规任务和记忆提取、总结、反思、去重；存储、索引、检索、管理和代码分析在本地。模型调用不是否决理由，但新增第三方托管记忆、远程AI、embedding、CDN、分析/遥测、更新下载、公共图示服务、GitHub同步与cloudflared等不因此获准。

插件/skill仅在当前任务明确指定可信目标时进行必要通信；不能放行所有私网或所有模型类服务。学习产物、图谱、HTML/XML、上下文导出与备份本地落盘，密码/cookie/token/私钥不进入模型、笔记或渲染文件。模型处理片段受scope与预算约束，队列绑定入队时批准Provider/模型/用途/会话，不因活动会话切换而漂移。

离线准备需固定commit、构件、锁文件、许可和资源摘要。当前轮允许公开资料调查不等于候选运行可联网；是否已经无外发须由源码、依赖、子进程/浏览器资源与运行证据共同证明。

## 3. 代码学习底座：VSCODE_READER 的实际定位

已读取本机 [SKILL.md](H:/VSCODE_READER/SKILL.md)、[README](H:/VSCODE_READER/README.md)、[capabilities](H:/VSCODE_READER/references/capabilities.md)、[workflow](H:/VSCODE_READER/references/workflow.md)。FACT：项目自述为 MIT 的 SDK Code Atlas v0.8 skill原型，含Clang语义、Python图分析/增量、Agent审阅导入和离线HTML；并非正式VS Code扩展。未运行doctor或测试，不声称当前运行时已就绪。

已有能力可复用：提供已求值compdb；重复 `--root` 与 `--compdb` 登记多仓/多构建；bounded调用与标量数据流；exact/may、未知、failed/pending TU和预算截断；snapshot与增量失效；离线HTML查看。Native CFG要求独立Clang18提取器，doctor核心ready不等于native CFG可用。Agent审阅只补当前证据下may候选，不能把猜测升级为编译事实。

状态文档存在分歧：SKILL/README仍写checkpoint方案待确认，而`references/workflow-checkpoints.md`标owner-confirmed/implemented。需按当前源码和测试定位实际行为并记录文档问题；本轮未运行，不择有利叙述当验收通过，也不因旧措辞要求用户重新批准已有决定。

当前workflow能发出阶段合同与历史nativeCFG/CI记录属于不同证据；历史本地Native CFG的skip不算当前通过。接入时需报告当前doctor各capability、执行版本与实际检查结果，不能继承历史成功计数或把文档状态当运行证据。

限制：任意指针/字段敏感别名、路径可行性、完整happens-before、跨函数回调生命周期、内核注册语义等仍未完整实现。现有通用锁/回调能力不等于已支持所有Linux内核锁、RCU或ops生命周期。多root可分析不等于跨仓协议自动闭合，也不等于读取完整构建全貌。

用户目标为Linux驱动与用户态组件。REQ-L01：采用真实Kbuild/内核CONFIG/架构/工具链/生成头文件对应的compile_commands；用户态组件用其真实构建数据库。禁止为方便阅读套用CMake或随意关CONFIG。CMake只用于本身采用CMake的登记子项目，且源码审查与明确允许后运行；已有compdb分析不授权构建脚本、下载或工具链执行。

REQ-L02：登记学习workspace manifest，包含每仓repo_id、root、commit/dirty摘要、compdb摘要、CONFIG/variant、架构、sysroot、生成头、共享UAPI/协议版本及路径映射。Atlas命令适配器与Serena激活都只在登记根内；不从父目录遍历兄弟仓，不自动fetch。未获目标工具链/生成头时报告缺口，不能伪造配置继续给完整结论。

Atlas `scripts/atlas/build.py`包含调用compdb中compiler作`-dM -E`与include路径探测的分支，因此“读取已有compdb”不等于绝不执行compiler。运行前必须核对可信compiler绝对路径/版本/摘要、wrapper和response-file、探测参数和读取范围，拒绝未登记可执行文件与外部命令，在受限环境执行；若当前环境不允许此探测则明确阻断，不伪称纯数据解析。不得仅因为不运行CMake就省略执行权限审查。

上述执行边界复用用户已给授权、可信配置与已批准参数，不要求每次读取、续读或同条件分析都重新询问；只有新增CMake执行、不受控compiler或越出既有任务范围时才处理相应新授权。本轮不执行这些操作，因此没有待用户批准的运行步骤。

REQ-L03：保留Atlas输出及schema，学习skill引用snapshot/实体/边/源码范围，不重写第二份Clang解析器。Serena仅补按需定义/引用导航；结构图MCP只补范围可见关系。引用不等于调用，调用需call-expression与目标绑定或运行证据；图示不改变exact/may/unresolved。

## 4. 学习编排 skill：学习行为而非索引按钮

建议形态为独立 `learn-code-workspace` skill（名称为拟议接口，本轮未创建），消费Atlas产物与只读导航，输出本地学习记录。它提供一条可暂停的小闭环，不把普通提问改成强制考试。

| 阶段 | 行为与输入 | 可观察产物/停止标准 |
|---|---|---|
| 定界 | 用户要能解释/判断的一个行为，例如ioctl到驱动处理入口；登记仓/variant | 一句学习目标、范围与未知；不从整个仓库课程开始 |
| 建图 | 读取当前snapshot覆盖、模块边界、入口与类型/调用候选 | 小范围模块地图；入口为候选时明确标注，不猜顶层runtime入口 |
| 走一条路径 | 由用户态入口到共享UAPI、驱动分派、ops/队列、硬件边界，逐边读源 | 每条边的证据位置/身份/类型、已知与未知；不以图的连通性证明实际执行 |
| 重建解释 | 用3—8句说清对象/生命周期、关键数据和失败边界；优先已有问题而非额外测验 | 简短mental model与因果链；用户尚未回答时写待完成 |
| 预测与核验 | 在进行验证前请用户预测一个具体结果；只读源码识别也可作为最小动作 | prediction/observation/difference分开；预测缺失时不代写，不声称掌握 |
| 留下证据 | 记录1—3条可迁移规则、未解问题和适用snapshot | 能用于一个新判断；没有收益/问题的K2/K3到此停止 |

REQ-L04：普通代码问题直接解释当前问题；上述阶段按需要执行，不要求用户每次填完整模板。用户明确学完或要求复盘时使用行为守则完整学习转化模板。每次学习回答单列“接下来该怎么做”，最多一个具体动作，包含用时和可观察完成标准。

REQ-L05：路径选择提供候选与歧义，不静默选择同名/重载。跨仓ioctl由命令值、共享UAPI布局、版本、compat与入口分派核对；EXPORT_SYMBOL只证明导出，Module.symvers/Kbuild/实际依赖才支持进一步判断。DMA、firmware mailbox、IRQ/workqueue到真实设备的运行行为不能仅从静态图证明。

REQ-L06：本轮不跑代码。未来需运行最小测试/trace时，先记录用户预测，再在获准的本地fixture或指定目标验证；设备、调试、刷写或副作用命令遵守对应已批准范围。Atlas历史fixture/CI报告不能替代用户真实仓库和目标证据。

REQ-L07：学习记录至少含goal、scope、repo/variant/snapshot、已读实体与证据、解释、prediction/observation、未知、规则、下一动作和完成状态；缺失预测/验证标待完成。不因生成记录就自动写长期记忆；若启用记忆，按本次用户已允许的受控提炼路径写入，附来源/版本，纠错/删除遵守tombstone和scope策略。

REQ-L08：暂停/续读使用学习记录游标，重进先核对snapshot与dirty摘要；版本变化标stale并重新核查受影响路径，不能把旧行号和旧CONFIG结论当现状。上下文被裁剪或回退后，也不伪造“已读/已懂”状态。

## 5. 图示组：编辑与解释

候选 [dsh-drawioedit](https://github.com/zhang-guo-wen/dsh-drawioedit) 用于侧栏编辑.drawio，包名迁移须按实时manifest匹配；当前候选名为`@guowenzhang/dsh-drawioedit`，旧namespace不能当安装命令。候选 [Archify](https://github.com/tt-a1i/archify) 为Agent图示skill，DSH集成独立opt-in；不是代码语义分析器。

REQ-DI01：优先使用Atlas已有离线HTML；需要讲解图时Archify从已核对边集合生成，保留源证据、snapshot、exact/may和未解析边。用户手改.drawio是注释层，不能回写为编译事实；导出图附来源和版本。

REQ-DI02：Draw.io编辑器、图标、字体、JS/CSS和导出器须本地提供；外部iframe/editor/CDN/URL图片/远程导出/AI入口禁用。postMessage严格绑定来源与窗口；XML/HTML/SVG/URL导入校验和转义，编辑图不能读取任意本地路径或自动访问URL。渲染不执行源码注释/模型文字内脚本。

已知drawio参数层对若干云SDK有禁用措施，不能写成原版毫无限制；但配置禁用不替代对vendor资源、字体/图片/URL、AI、导出和实际渲染网络的完整验证。

REQ-DI03：Archify更新检查按官方配置关闭（调查线索`ARCHIFY_UPDATE_CHECK_DISABLED=1`），但还须查依赖、集成和产物资源，不以一个环境开关认定无外发。只使用经审计DSH opt-in包，不启用其他Agent安装脚本、陌生模型或自动发布。

## 6. 上下文组：观察与可控修改

[bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) 作为上下文组成、演进、压缩与多Agent可视化候选；它与长期记忆不同。[SkanderBog/dsh-context-manager](https://github.com/SkanderBog/dsh-context-manager) 仅作压缩工具对照，不能因名字相近替代用户指定项目。

REQ-CT01：首阶段只读展示当前实际模型输入、工具/记忆注入与预算，区分估算/实际token和历史快照/下一次请求；不以UI显示推断主模型一定收到了内容。展示与导出也需过滤秘密，context panel不得把全文送到额外外部服务。

dsh-context的`host/promptInjection.ts`含可选系统prompt前/后缀路径，配置默认空；所以项目不只是观察器。首阶段只读配置必须固定为空并关闭注入，验证没有prompt变化；Host投影注册和查看不等于修改已持久化历史，不能把这两类行为混为一谈。

REQ-CT02：任何上下文删除/修改/压缩功能单列显式操作、预览与版本校验，不能只是UI隐藏却宣称模型已遗忘；压缩需调用模型时允许通过既有Provider，受预算和路由绑定，禁止额外服务回退。保留当前用户指令、工具调用结果配对和必要证据，不因优化token丢失权限范围或把记忆升格为指令。

## 7. Rewind：回退一致性与不确定状态

[SiriLee/dsh-rewind](https://github.com/SiriLee/dsh-rewind) 为已发现候选，文档声明同窗口对话回退与本地工作区备份；仍需消歧用户所指版本/仓库并核实当前源码。它不等于删除会话或Git分支，也不保证还原外部系统。

REQ-RW01：回退前停止本会话写入并取得运行租约，预览目标轮次、将被对话surface遮蔽的内容、文件新增/修改/删除和未捕获范围。回退不等于删除append-only会话日志、备份或模型服务已有请求，不宣传为隐私抹除。本地恢复须校验实际根、软链接、路径身份及内容是否被外部修改。冲突拒绝保留双方，不能覆盖用户并发改动；不以未跟踪/忽略文件或备份缺失当作安全可删。

SiriLee源码注释明确subagent edits不跟踪，snapshot只覆盖其tracked tool修改；不能推定AutoEnv、shell命令、子代理、用户手改或其他插件写入均可恢复。预览必须列捕获来源、覆盖清单、遗漏和`incomplete`状态；没有完整快照时只承诺已捕获部分，不把会话回退成功描述为整个工作区已还原。

REQ-RW02：会话日志、运行状态、内存投影、workspace文件恢复分成可恢复事务或有日志的分阶段操作，失败显示partial/unknown并保留回滚证据。崩溃、重复操作、磁盘满、多个worktree和正在运行的任务须测试。只恢复明确纳入的本地文件，不跟随命令去回滚SSH主机、数据库、认证登录态或已发送模型请求。

REQ-RW03：回退或文件恢复会使Atlas/codegraph快照失效，学习记录标stale。已提炼记忆不随对话回退自动变真或消失：给出受影响来源清单，按用户选择失效/保留，阻止已回退轮次的在途记忆结果晚到重写。scope与备份tombstone策略沿既有记忆设计，避免恢复旧快照复活已删秘密。

## 8. UI外壳组：按模块评估

[zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) 为聚合生态候选；调查当前dev分支与旧`dsh-web-ui/@linxin666/dsh-web-ui-all`到`dsh-web-all`迁移需锁具体版本。仓库名、分支、npm包、子模块和宿主兼容范围分别记录，不能把旧教程装法当当前事实。

REQ-UI01：只选解决当前缺口的子模块，不默认安装聚合包。对浏览器、终端、Git、图示、记忆、上下文、rewind逐一指定唯一写入/拦截者；避免重复memory工具、多个Provider、重复compress/turn hooks及全局样式覆盖。UI皮肤不授予执行/数据读取权限。

REQ-UI02：工坊/市场、版本检查、资源下载、GitHub同步、远程AI、消息通知和cloudflared隧道必须保持关闭/移除，网络策略仍强制；不能因隐藏按钮认定代码不可执行。离线资源与路由鉴权、CSP、Origin、上传/URL导入限制须完整审计，聚合包任一子模块不能借宿主权限绕过。

主调查已见聚合patch挂载market、task-board-github、remote-bridge等；GitHub模块enabled默认true但repositories默认空，remote-bridge有APNs/relay/push路径。这证明有需控制的能力与配置路径，不证明未配置也必然开机外发；逐项追踪触发条件，未用模块从受控组合移除。

## 9. 验收与交付顺序

| TEST | 覆盖 | 通过判据；本轮均待执行 |
|---|---|---|
| EL-01 身份/供应链 | 所有候选 | canonical repo/package/commit/宿主版本/许可/依赖与发布产物对应；Eagle和Rewind歧义不默选 |
| EL-02 全链出口 | 所有候选 | 离线冷启、正常/错误/更新/导出/URL导入/恢复，除主模型与指定可信目标外无尝试，额外CDN/更新/同步/隧道来源查清移除 |
| EL-03 Atlas接入 | L01-L03 | 合成Kbuild/用户态双仓和真实compdb字段，CONFIG差异、缺生成头、失败TU、nativeCFG缺失均明确；不运行CMake替代；compiler probes只允许固定可信二进制，恶意compiler/wrapper/response-file被阻断，非纯数据路径不伪装只读 |
| EL-04 学习闭环 | L04-L08 | 同一入口任务产出有证据路径、解释、预测与待验证区分；暂停后改代码续读标stale，不声称用户已掌握 |
| EL-05 图示 | DI01-DI03 | 本地无网络编辑/生成/导出，证据及certainty可追溯；恶意XML/SVG/链接/脚本无法执行或越根读取 |
| EL-06 上下文 | CT01-CT02 | UI观察与实际请求可比，秘密过滤；只读模式prefix/suffix为空且无注入；显式修改不破坏调用配对、当前指令与Provider绑定；导出不外传 |
| EL-07 回退 | RW01-RW03 | 临时profile+fixture回退/重启/故障/冲突/跨worktree/记忆晚到与旧备份恢复；subagent/shell/手工修改等未捕获来源显示incomplete，surface遮蔽不宣称日志删除；不覆盖外部改动，不假称远端已回滚 |
| EL-08 共存 | UI01-UI02 | 逐模块启用，功能冲突可诊断且卸载可恢复；无重复writer/工具/hook，关闭页面不残留后台下载或监听 |

建议阶段：① 现有Atlas的受限分析能力与学习流程设计先评审；② 固定构件后在无私有代码的fixture验证学习闭环；③ 需要解释时接图示，需要观察时接context；④ 单独验证兼容版本rewind一致性；⑤ 最后评估最小UI组合。Ego作为可能对应的浏览器候选可独立调查，Eagle身份保持未确认，不拖延其他独立调查。

架构方案可独立审查，部署准入尚未取得。Atlas实际运行时、内核目标适配、候选完整源码外发、共存兼容和Eagle身份均有未验证项；新增学习编排只提出接口和行为，没有创建或安装skill。知识定位K1/G/Q，当前不需继续扩展解析器或课程。

**接下来该怎么做：** 用约20分钟选定一个用户态ioctl到驱动分派的学习问题，列出登记仓、真实compdb/CONFIG和预期会经过的3—5个位置；完成标准是一张能区分“已有证据/预测/待验证”的路径表。先请用户预测，再开展后续只读验证，本轮不把预测或观察写成已完成。
