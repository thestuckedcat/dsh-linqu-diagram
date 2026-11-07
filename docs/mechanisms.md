# 06 本地图示：机制说明

更新：2026-11-07。状态：**组件级实现与自测完成，真实 Host 安装/浏览器旅程未执行**。本文件按[机制说明合同](references/mechanism-document-contract.md)解释 06 的实际行为，作为后续改进 [skill](../skills/explain-local-diagram/SKILL.md) 的依据。设计与来源见[软件设计](software-design.md)、[实现路线](implementation-route.md)、[兼容矩阵](compatibility.md)；本文只写**实际已实现并能被测试/代码定位**的机制，未运行的平台能力标为待验证。

## 1. 能力与分层

06 解决两个场景：①把 Agent 选定的证据子集或用户概念描述变成**离线、可追溯的讲解图**；②用户在本地**受限可视化编辑器**里拖拽、加注释、增删 annotation 边并按版本保存 `.drawio`/JSON/SVG。手改图永远是注释，不提高代码关系可信度。

| 层 | 负责 | 不负责 |
|---|---|---|
| Agent skill（`skills/explain-local-diagram/SKILL.md`） | 选范围、选已登记证据子集、调用 CLI、按固定模板讲解、报告 stale/truncated/unresolved、停止条件 | 不写事实库、不改 certainty、不伪造证据/身份、不联网、不调用第二个模型服务 |
| 06 CLI（`tools/render.mjs` + `src/*`） | schema/证据/限额校验、确定性布局、SVG/HTML/图包、`.drawio` 转换、原子提交与幂等 | 无 Host 凭据、无会话修改权、不启动编辑器 |
| Host plugin（`plugin/index.mjs` + `src/plugin/service.mjs`） | 认证 RPC 通道、owner Peer、registry 文档许可、单 writer 保存、不可变修订、operation/journal | 不分析代码、不读取未登记路径、不把 XML 当权限 |
| Client plugin（`plugin/client.js`） | main 面板、查看器、拖拽/键盘/注解、undo/redo、冲突视图、导出请求 | 不直连文件系统、不自行授予文档许可、不把本地模型当权威 |
| 宿主/OS | 认证 Peer、Connection 传输、Cordis 生命周期、文件系统与进程 | 未被本轮验证的 OS 级全进程出口仍属外部门禁 |

凭据：06 不读取任何凭据、不调用模型 API；模型服务不在本模块路径上（讲解由宿主 Agent 完成，renderer/editor 纯离线）。

## 2. 端到端机制图（一次典型旅程）

```text
用户："把 svc_main 这条路径画出来"
  -> skill: 选已登记 snapshot 的证据子集（节点/边 + evidence_ref + certainty）
  -> tools/render.mjs --evidence subset.json --source-identity identity.json [--current-identities cur.json]
       -> evidence.toDiagram: schema 校验、certainty 不提升、手工边 annotation、局部 ID、coverage
       -> source-state: current/stale/unknown（只比身份，不证明运行行为）
       -> layout.layered_v1: SCC + 最长路 + 重心排序（确定性）
       -> render-svg/render-html: 白名单 SVG + CSP 离线 HTML（图例/等价文字/来源栏）
       -> drawio/xml.exportDrawio: 受限 mxGraph 子集
       -> archive: staging -> manifest -> fsync -> 同卷 rename 到不可变 artifact 目录
  -> skill 读取 stdout JSON + diagram-spec.json，按模板报告 exact/may/unresolved/truncated/stale
用户打开 index.html（断网）：点选节点/边看来源定位与置信；无远程资源
用户打开 Harness "图示" 面板（Host 通道已就绪时）：
  -> document.open：owner Peer + registry 文档许可 + 受控读取 -> base_spec/overlay/XML/version/session
  -> 本地编辑（命令在 client 执行，不逐键 RPC）
  -> document.save：Host 用自身 base 复核 overlay、重算 canonical XML、语义比较 client XML
       -> 成功：不可变修订 + journal + 新 generation
       -> 冲突：保留双方 + draft_ref，不自动取最新 token 重试
  -> 重新打开从同一不可变 revision 读 base/overlay/XML
后续：03 事件 fixture 使相交 repo 的 source_state=stale；04 可写 artifact_ref；08 只导航
```

取消/部分/恢复：图包提交前取消 → 清 staging，返回 `cancelled`；提交后取消 → `saved` 且说明取消过晚；rename/指针状态无法确认 → `outcome_unknown`，UI 只提供"检查状态/导出草稿"；保存崩溃 → 按 journal `prepared→revision_written→pointer_updated→saved` 恢复，指针不回退覆盖旧版本；磁盘满 → 保持旧指针与草稿，返回 `outcome_unknown`/`failed`。

## 3. 决策规则（稳定机制编号）

| 机制编号 | 触发/场景 | 输入与前置条件 | 判断规则 | 工具/状态变化 | 输出/证据 | 异常与用户提醒 | skill 可调 | 硬边界 |
|---|---|---|---|---|---|---|---|---|
| DIA-EVID-01 | 生成 evidence 图 | 已登记 `SourceIdentityV1` + `EvidenceSubset`；证据引用 `evidence_ref{source_id,repo_id,path_ref,content_digest,line}` | `origin=evidence` 边 certainty 不得超过来源级（exact 需 refs 且 refs 结构合法：repo 已声明、相对安全路径、行号区间、非空 digest）；`reference` 不得升级 `call`；无证据边必须 annotation/unknown；概念模式 sources 必须空且全部 annotation/unknown；`coverage.complete` 恒 false；超限拒绝或按 policy 显式截断并计 omitted。**内容真实性**：默认只做结构校验并在 coverage 明确 `structurally validated only`；调用方传入 `policy.verify_evidence`（04/Atlas manifest 或 CLI `--verify-evidence-roots`）时逐 ref 校验，失败整图 `INVALID_SPEC`，不做静默降级 | `toDiagram` 产出规范 spec；不读全仓、不调用模型；布局坐标在此写入 spec | `tests/evidence.test.mjs`、`tests/review-regressions.test.mjs`（R-02） | 缺证据/超限/verifier 失败 → `invalid`+稳定 code；结构未核时 CLI/HTML 显式警告，不把 exact 说成已内容验证 | 选子集、方向、标题、是否截断、是否提供 verifier | certainty 提升、伪造 source/evidence 结构、全仓扫描由代码拒绝；**内容真实性不能由 CLI schema 单独证明**，必须由注册 manifest/本地 roots 提供 |
| DIA-EVID-02 | 生成前/打开时/刷新 | spec 的 snapshot 身份 + 当前登记身份 | 逐 repo 比较 snapshot/manifest/revision/dirty/build_variant/arch/compdb/generated_headers；任一差异 stale 并列 changed_refs；缺当前身份 unknown；`current` 只表示身份一致；spec 中 `root_ref` 是 `root-ref:<16 hex>` 不透明引用（不持久化本机路径） | `validateSource` 纯比较 | `tests/source-state.test.mjs` | stale/unknown 在 HTML/面板显著显示；旧行号不跳到新代码 | 何时重核、提示语 | 不能把 stale/unknown 标 current，不能只比文件名/commit |
| DIA-GEN-01 | 渲染布局 | 通过校验的 spec | 节点按稳定 ID；Tarjan SCC；SCC DAG 最长路分层；两次上游重心扫描，tie 按 ID；整数坐标；160×64 最小；96/32 间距；自环/回边独立折线；相同输入逐字节一致；**生成时把确定性 positions 写入 spec.layout**（R-01），`TB` 方向在渲染/归档/store 导出全部传播 | `layoutDiagram`/`routeEdges` | `tests/layout.test.mjs`、`tests/review-regressions.test.mjs`（R-01） | 超 500 节点/1000 边拒绝或截断 | 方向、间距参数（schema 内） | 不得因布局改变 certainty/边集合；空 positions 的 spec 不能再当可编辑基线 |
| DIA-GEN-02 | 生成 SVG/HTML | spec + overlay + layout | SVG 只写白名单元素/安全属性并全部 XML 转义；HTML 内联固定脚本+样式，CSP `default-src 'none'` 且 hash 固定；无 fetch/WS/eval/远程字体图片；图例、等价文字、来源/版本、截断/隐藏/stale 提示 | `renderSvg`/`renderHtml`/`assets` | `tests/render.test.mjs`（11）、`tests/assets.test.mjs`（7） | 恶意 label 只作纯文本；资源校验失败拒绝复用 Atlas HTML | 颜色/布局/文案（不改白名单） | SVG/HTML/CSP 白名单由代码固定 |
| DIA-GEN-03 | 提交图包 | spec/overlay/output_ref/operation_id + 可信 caller grant | 按 operation_id staging；写 7 文件+manifest；fsync；同卷 rename 到不可变 `artifact-<id>`；同 operation 同内容复用；不同内容冲突；提交前取消清 staging；复用的已有 artifact/staging 必须重算 manifest 的 size+sha256，字节被替换时 `outcome_unknown` 而不是 `saved`（R-11） | `archive.renderLocal` | `tests/archive.test.mjs`、`tests/render-cli.test.mjs`、`tests/review-regressions.test.mjs`（R-11） | 半包不开放；outcome_unknown 明确返回 | 输出目录/文件名不可调；operation 命名可调 | 原子性、不覆盖已有目录、损坏包不得当成功由代码保证 |
| DIA-OUT-01 | 需要本地执行器/资源 | `source-lock.json` 登记 command + 本地执行器 | 未登记 command 拒绝；固定绝对路径、参数数组、`shell:false`、`windowsHide:true`、环境白名单+固定 `ARCHIFY_UPDATE_CHECK_DISABLED=1`；超时/取消杀进程树；资源文本无远程引用；`//server` 与 `\\\\server` UNC 均不算本地绝对路径（R-06） | `runner.runLockedCommand`、`network-smoke` | `tests/runner.test.mjs`、`tests/source-lock.test.mjs`、`tests/review-regressions.test.mjs`（R-06） | 拒绝返回固定 code；网络尝试被记录并失败 | 谁能触发、超时值 | 路径/环境/进程树/出口策略由代码固定；本轮 `commands: []`（未采用执行器） |
| DIA-XML-01 | 导出/解析本工具 `.drawio` | 合法 spec+overlay（≤限额） | 受限 XML 子集：无 DOCTYPE/ENTITY/CDATA/PI/注释/命名空间/重复属性；先限字节/深度/元素/属性；root 0+三 layer；`base:`/`overlay:` 前缀；ann 属性 annotation/unknown；隐藏项 visible=0 但 JSON 保留；导出坐标为 spec.layout 的真实布局（R-01） | `exportDrawio`/`parseDrawioXml`/`canonicalMxGraph` | `tests/xml.test.mjs`、`tests/review-regressions.test.mjs`（R-01） | 非法/超限拒绝，不删字段强存 | style 颜色/字号枚举 | 解析子集、属性白名单由代码固定 |
| DIA-XML-02 | 导入外部 XML | 外部/历史 `.drawio` 文本 | 一律按无可信证据 conceptual 读入：几何/文本/端点 → overlay annotation；`data_*` 只显示不提升；压缩内容/未知高级形状 unsupported；无证据边不写 exact；**CLI `--import-drawio` 已提供用户入口**（R-07），可用 CLI 渲染成 7 文件 conceptual 图包 | `importExternalDrawio`、`tools/render.mjs`、空 conceptual base | `tests/import.test.mjs`、`tests/review-regressions.test.mjs`（R-07） | 返回 warnings/unsupported，不静默丢内容 | 是否允许导入（产品开关） | 升格事实、压缩/未知形状执行由代码拒绝 |
| DIA-EDIT-01 | 用户编辑 | EditorModel + 命令 | 严格命令 union（10 种）；payload 关闭；命令 ID 同 digest 幂等/异内容冲突；`expected_draft_revision` 过期 stale；复合历史（删节点含关联项，并清理 target 指向被删 annotation 边/节点的 note，R-08）；redo 新编辑清空；最多 100 条/2MiB；base 不可变；丢失目标进 orphaned | `createEditorModel/executeEdit/undo/redo` | `tests/editor-model.test.mjs`、`tests/review-regressions.test.mjs`（R-08） | stale/invalid 固定提示；拖拽 pointerup 才提交 | 快捷键、步长、UI 流程 | 命令集合、base 不可删、证据不可升格由代码固定 |
| DIA-EDIT-02 | 可选 iframe bridge（未启用运行路径） | 消息 v1 + 锁定 origin/window/nonce | 校验 origin/source/128bit nonce/session/schema/大小；未知 type 拒绝；message_id 去重、同 ID 异正文冲突；save 绑 XML+overlay digest；nonce 不写 URL/log | `createBridgeGuard/validateBridgeMessage` | `tests/bridge.test.mjs` | 伪造/重复/超限拒绝 | 是否使用 iframe（默认不用） | 通配 postMessage、nonce 泄露由代码拒绝 |
| DIA-DOC-01 | 打开文档 | `document_ref` + caller + registry | owner 且 registry 有该 context/document（read/edit）+ 每次 lookup 重核 realpath 身份/scope 代次/active；受控读取得到 xml/base/overlay/version/session；同一次读取禁止先读 XML 再补 token；文档版本仅暴露 generation/hash/size，不返回 data/output 真实路径 | `document-store.openDocument`、`access` | `tests/access.test.mjs`、`tests/save.test.mjs` | denied/unavailable 固定码；不泄露路径 | 打开哪个已登记文档 | owner 登录≠文件许可；任意路径读取由 registry 拒绝 |
| DIA-DOC-02 | 保存/导出 | expected_version + XML + overlay + operation_id | 单 writer；expected_version 必填（generation+hash+size+path identity）；A/B 冲突保留双方+draft；不自动取新 token；临时文件+fsync+原子 replace；幂等绑定 expected_version+xml_digest+overlay_digest；journal 恢复；导出 exclusive create 冲突；撤销按 scope_generation 级联，旧代次撤销不影响新代次（R-04） | `saveDiagram/exportArtifact/getOperation` | `tests/save.test.mjs`、`tests/paths.test.mjs`、`tests/journal.test.mjs`、`tests/review-regressions.test.mjs`（R-04） | conflict→用户导出草稿/重开/显式合并；outcome_unknown→不盲重发 | 冲突后动作由用户决定 | 无 version 保存、自动重试、覆盖外部文件由代码拒绝 |
| DIA-RPC-01 | Host 面板请求 | 认证 Peer + 请求外壳 | 只接受 `peer.principal.kind==='owner'`；外壳 `{schema_version,operation_id,context_ref,expected_scope_generation,view_epoch,input}` 关闭校验；响应闭合 union；异常统一 `INTERNAL_FAILURE`，不返回 document/store/output 路径、XML 原文、stack、配置；base_spec 的 `root_ref` 为 `root-ref:<digest>` 不透明引用（R-09）；`operation.get`/`session.close` 必须带 `document_id` 并绑定所属文档（R-10）；12MiB 上限；旧 epoch 响应不更新 | `src/plugin/service.mjs`、`plugin/index.mjs` | `tests/service.test.mjs`、`tests/plugin-index.test.mjs`、`tests/descriptor.test.mjs`、`tests/review-regressions.test.mjs`（R-09/R-10） | denied/stale/invalid/conflict/unavailable 固定码；卸载撤销 session | 无（客户端不调策略） | owner/registry/外壳/脱敏/文档绑定由代码固定；真实 Host 旅程待验证 |
| DIA-UI-01 | 用户打开"图示"面板 | client bundle + 已登记文档 | `main` 槽 key `local-diagrams`；`ctx.connection.rpc.call` 结果先查 `.ok` 再验 value；只渲染白名单 DOM/SVG；拖拽/键盘/注解/undo/冲突/导出可用；冲突"Reopen"丢弃本地草稿并只加载 Host 版本（R-05），"Keep both"才 rebase+合并；不 fetch/eval/远程 URL | `plugin/client.js`（由 ui/ 构建） | `tests/client-bundle.test.mjs`、`tools/editor-smoke.mjs` | 组件未就绪明确阻断；没有假保存按钮 | 面板布局/文案/快捷键 | 渲染白名单、RPC 用法、版本保存合同由代码固定 |
| DIA-EVT-01 | 03 事件 / 跨模块 | 03 v1 事件 fixture | event_id 去重；generation 跳号→unknown；workspace_files_restored 相交 repo→stale（缺 after_snapshot→unknown）；session_surface_rewound 不废独立 snapshot，只记录重核 reason 并提示来自该对话的注释需人工复核（overlay 当前没有会话来源字段，不自动逐条标记）；session_removed 只清关联不删 artifact；partial/unknown 不升 current | `src/events.mjs`、`artifactRefFor` | `tests/interop.test.mjs` | 提醒重核/人工复核；不自动重绑 | 何时提示 stale/待核 | 事件升格事实、猜 after_snapshot 由代码拒绝；真实事件订阅未接线 |
| DIA-SKILL-01 | Agent 生成/讲解 | 用户请求 + 已登记输入 | 先查 CLI 能力与输入；只选/引证据，不造 EvidenceSubset/identity；用固定模板报告 mode/source_state/节点边/truncated/warnings/manifest；exact 只说静态解析；无证据且无明确描述就停 | skill + CLI | 运行记录见 `evidence/`、skill 自测 | 明确 `generation_seam_missing`/input 不可用/超限 | 图范围、讲解顺序、是否提问、布局参数、stale 提示 | 不能改 certainty、不能绕过 schema/许可/版本/出口 |
| DIA-PKG-01 | 安装/交付 | 本仓库包 | `dsh.bundle.patch` + `dsh.client`；无第三方依赖；未执行安装；兼容矩阵保持 unknown 直到目标版本重核；许可/NOTICE 记录调查来源而非合入 | `package.json`、`cordis.patch.yml`、`docs/compatibility.md` | 本轮未安装 | 未就绪明确阻断，不提供假安装成功 | 无 | 装包/激活/浏览器 CSP/卸载清理由真实 Host 验证 |

## 4. 来源与设计原因（为什么这样设计）

- **证据 / 推断 / 注释不混层**：来自 Atlas 调查（exact/may/unresolved、snapshot 身份）与设计 DIA-01。代价是图可能"不完整"（unresolved 显示为未知），但避免把静态解析或用户手改说成运行时事实。实现上 exact 必须有结构合法的 refs、`reference` 永不升级、概念/导入全部 annotation/unknown；**内容真实性不是 schema 能单独证明的**：默认在 coverage 标注 `structurally validated only`，只有注入 04/Atlas manifest verifier 或 CLI `--verify-evidence-roots` 时才逐 ref 校验并在失败时拒绝整图。
- **自有确定性 renderer 与受限 XML**：Archify/Drawio 尚无已审计的固定构件与 rc.5/出口证明（[实现路线](implementation-route.md) §2）。自有渲染只输出白名单 SVG 与固定 CSP，回归可离线复现；代价是没有通用 drawio 的高级形状/多页，对应外部导入 `unsupported`。
- **不可变修订而非原位覆盖**：设计 §8 明确跨任意外部 writer 的平台级 CAS 未证明；选择 `documents/<id>/revisions/...` + 单 writer + journal，冲突保留双方。代价是用户会看到新版本文件路径与"另存"体验，而不是直接覆盖原文件；换来不丢用户内容、不盲目换 token。
- **owner Peer 与文档许可分离**：认证浏览器是共享 owner Peer，不等于任意文件可读。registry 由本地可信 CLI 登记，RPC 每次重核路径身份/scope 代次/active；RPC 响应不包含 document/store/output 真实路径，base spec 的 `root_ref` 也是不透明引用。代价是首次使用需要登记文档/输出根（本地操作），而不是"登录即可打开任意图"。
- **skill 与 plugin 分工**：skill 只能调范围/讲解/提示，无法改 schema、certainty、网络与版本事务；插件/CLI 是硬边界。这与用户要求"skill 改进不能绕过权限或把未验证结果当事实"一致。

## 5. skill 改进接口 vs 硬边界

**可由 skill 调整**（改 SKILL.md/references 与调用参数即可）：图范围与选哪些节点/边；布局方向与讲解顺序；何时提示 stale/truncated/unresolved；是否先提问要证据；报告模板措辞；CLI 的 `--title/--diagram-id/--revision/--scope-ref` 等非安全参数；概念图与证据图的取舍；用户拒绝缩小范围时的停止方式。

**必须改代码/策略，不能由 skill 变更**：DiagramSpec/Overlay/EditorModel/RPC schema 与 additionalProperties；`certainty` 不得提升、`reference` 不得升级 call；证据模式禁止伪造 source/evidence；scope/registry/路径身份与 document 许可；网络 none、`source-lock` 执行器允许列表、环境固定；HTML/SVG/XML 白名单与 CSP；版本保存合同（expected_version、不可变修订、冲突不自动重试、journal）；owner Peer 校验与固定 reason_code；client bundle 的平台模块与 RPC 用法。

## 6. 证据与下一次验证

**已实际运行（组件级，2026-11-07，Node v26.13.0，临时目录/合成 fixture/无网络）**：`node --test tests/` 全绿（最终计数见 [最终自测摘要](../evidence/final-summary.md) 与 `evidence/final-test-run.json`）；`node tools/render.mjs --fixture/--evidence/--conceptual/--import-drawio` 均 exit 0、7 文件、remote_refs=0、manifest 摘要可复现；`node tools/network-smoke.mjs --isolated --renderers builtin` → attempted_count=0；`node tools/editor-smoke.mjs --isolated --fixture` → 12/12 检查、13 次服务级 RPC、0 未登记网络尝试；`node tools/build-client.mjs --check`、`node tools/validate.mjs`、`node tools/check-runtime.mjs` 均 exit 0。逐命令记录与限制见 [最终自测摘要](../evidence/final-summary.md)。

**独立评审与修复**：[docs/review.md](review.md) 记录了独立评审（HEAD 30d3fd4）的 11 项 blocker/major 发现；本实现已修复 R-01（生成物布局坐标）、R-02（证据内容校验入口与措辞）、R-03（validate 假绿）、R-04（scope 代次级联撤销）、R-05（Reopen 不合并）、R-06（UNC 路径）、R-07（CLI 导入入口）、R-08（注解节点/边删除清理）、R-09（root_ref 不透明化）、R-10（operation/session 文档绑定）、R-11（图包字节校验），并新增 `tests/review-regressions.test.mjs` 覆盖。评审未验证的真实 Host/浏览器/OS 出口门禁保持不变。

这些证明的是**模块行为与合同**，不证明：真实安装/激活、浏览器实际 CSP/DOM 旅程、真实登录 Peer→channel→registry→document-store 全链路、卸载后旧 RPC、OS 级全进程出口、真实 Atlas/Archify/Drawio 契约、用户数据上的质量。

**下一次验证（按优先级）**：①按 `docs/implementation-route.md` §5 在隔离 profile 安装本包并跑真实 `document.open/save/export` 与浏览器面板；②对比 CSP 与网络记录，确认零未登记外发；③卸载后旧 RPC/session 拒绝；④真实 Atlas 证据子集替换合成 fixture，验证 exact/may/unresolved 与 stale；⑤若启用 Archify/Drawio，先补来源锁/许可/出口审计再重跑 T3/T4。

**改进假设（未验证）**：拖拽/键盘的复合历史在真实浏览器 Pointer Events 下的手感与取消行为；大图（接近 500 节点）在面板中的交互性能；真实 03 事件接入后的 stale 提示频率；`.drawio` 与外部 drawio 应用互操作的形状范围。均需真实 Host/浏览器实验，不能以本文断言。
