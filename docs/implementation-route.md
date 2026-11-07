# 06 本地图示：实施路线与来源

更新：2026-11-07。状态：**实现中（组件级自测）**。本文件按 [工作区规则](references/workspace-agents.md) 要求，在正式实现前留档实施顺序、首个可验交付、来源固定版本、每个来源对应的机制与采用方式，以及本项目必须补足的隔离/状态/出口边界。设计依据为 [软件设计](software-design.md)（DIA-DESIGN-2）与 [产品形态](product-form.md)（DIA-PF-1）。

## 1. 实施顺序

1. **T1 证据与合同（DIA-01/02）**：`source-lock.json`、严格 `DiagramSpecV1`/`SourceIdentityV1`/`EvidenceRefV1` schema、Atlas 证据子集→规范图、`validateSource` current/stale/unknown。首个可验交付是"四类边 fixture 生成规范 spec，换 snapshot 变 stale"。
2. **T2 确定性生成（DIA-03/04）**：`layout.mjs`（Tarjan SCC＋最长路分层＋稳定重心排序）、自有 SVG/HTML renderer、资源清单、原子产物与幂等、`tools/render.mjs`、生成/讲解 skill。
3. **T3 出口（DIA-05）**：`assets.mjs` 离线资源校验、锁定执行器 `runner.mjs`、`tools/network-smoke.mjs` 负向网络尝试记录。
4. **T4 受限 XML 与编辑（DIA-06/07）**：`drawio/xml.mjs` 受限 tokenizer/序列化、导入降级、`editor/model.mjs` 完整命令 union、`editor/bridge.mjs` 源/窗口/nonce 校验、自有 SVG 编辑器（默认）与可选 iframe bridge。
5. **T5 版本与保存（DIA-08/09）**：`document-store` 单 writer/不可变修订/journal/草稿、冲突不自动重试、路径身份校验、`saveDiagram`、导出独占创建。
6. **T6 宿主入口与组合（DIA-10）**：rc.5 Host `ctx.connection.rpc.handle('/local-diagrams', ...)` 薄适配、client main 面板、08 导航 descriptor、03 事件 fixture、卸载清理、`tools/editor-smoke.mjs`。
7. **T7 交付**：机制说明、许可/NOTICE、兼容矩阵、独立评审与运行证据。

首个可验交付：含 exact/may/unresolved/annotation 四类边的合成图包，断网可查看、来源可逐边回查、换 snapshot 标 stale、恶意标签不执行。随后完成本地拖拽编辑和版本化保存再算首版组件闭环。

## 2. 来源与固定身份

| 来源及固定身份 | 提供的机制 | 采用方式 | 边界 |
|---|---|---|---|
| 本设计 [software-design.md](software-design.md) DIA-DESIGN-2（2026-11-07） | schema、状态机、RPC 合同、XML 边界、保存语义 | **自行实现**，本文件与设计作为编码依据 | 设计不是运行证据；未执行项在 evidence 中列为 unknown |
| 本机 Atlas `H:/VSCODE_READER`（自述 SDK Code Atlas v0.8，MIT） | snapshot 身份、exact/may/unresolved、离线 Viewer 与已有边/源码证据 | **仅调查对照**：只定义 `EvidenceRefV1` 适配合同与合成 fixture，不复制、不调用、不做语义分析 | 未运行 doctor/索引；本机当前没有可用 Atlas 产物，实施只验合成 snapshot |
| [Archify 3.2.0](https://github.com/tt-a1i/archify/tree/a4065941f12be7967436261d9934784e381d423c)，固定树 `a4065941f12be7967436261d9934784e381d423c`，Apache-2.0 | Agent 讲解图的布局/可视约束、opt-in skill 形态 | **只借鉴机制**：布局确定性与讲解顺序；renderer 用自有实现，不 vendor、无更新检查 | 未取得发布包/依赖/许可完整审计，因此不启用为执行器 |
| [dsh-drawioedit 1.3.0](https://github.com/zhang-guo-wen/dsh-drawioedit/tree/bfbcf347f26d9158f7f34bbb6ce416e504b74cdd)，固定树 `bfbcf347f26d9158f7f34bbb6ce416e504b74cdd`，Apache-2.0 | 本地编辑器、禁云 SDK 配置、save 版本守卫思路 | **仅调查对照**：保存守卫与命令模型自行实现；不 vendor 其 wrapper/editor 资产 | 上游无 token 路径不能原样采用；未核 vendor 版本/许可证，因此不交付 Drawio 增强 |
| 本机 DeepSeek Harness `0.2.1-rc.5`（app.asar SHA256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915`，嵌入 Node 24.21.0 / Electron 44.7.0 / hostProtocolVersion 4） | client main panel、鉴权 RPC、Cordis 生命周期、client 模块装载 | **薄适配，不升级**：本机源码核对 `ctx.connection.rpc.handle(channel, handler)`（handler 收到 endpoint/payload/signal/peer，返回 `{ok:true,value}` RpcResult）、client `ctx.connection.rpc.call(channel, endpoint, payload, signal)`、`ctx.slots.inject/register` 与 `ctx.layout.selectPanel`、`window.__ModuleLoader__.load({id,factory(require)})` 懒 CJS bundle 格式 | 未安装、未启动完整 Host 旅程；CSP/浏览器出口/卸载后旧 RPC 仍列待验证 |
| Node.js ≥ 24.9（本机 v26.13.0 用于测试） | `node:test`、`node:crypto`、Atomics/fs | 标准库直接使用；不新增 npm 运行时依赖（零第三方依赖） | 不把本机 Node 版本当最低支持承诺；`engines` 与实际宿主 Node24 分别记录 |

**没有直接复用的上游源码。** 本项目不 vendor Archify/Drawio/Atlas 代码；所有图形渲染、XML 子集解析、编辑模型、document store、RPC 适配均为自有实现。因此 `source-lock.json` 记录的是"接口/调查身份"而非合入字节；未核许可的候选不进入交付。

## 3. 本项目必须补足的边界

- **证据不可提升**：`origin=evidence` 的 exact 边必须有锁定证据且 certainty 不得高于来源级别；`reference` 不能因连到函数升级为 `call`；概念图/导入 XML 一律 annotation/unknown。XML 自定义 `data_*` 不是信任凭证。
- **隔离**：renderer 无网络、无 fetch/WebSocket/eval；HTML CSP `default-src 'none'` 且只允许固定 hash 的内联脚本；SVG 白名单元素/属性；XML 解析拒绝 DOCTYPE/ENTITY/CDATA/PI/命名空间/重复属性/压缩内容，先限字节/深度/节点数。
- **状态**：`current/stale/unknown` 按 snapshot、dirty、build variant、compdb、生成头摘要比较；保存用不可变修订（`documents/<id>/revisions/<generation>-<sha>.drawio`）＋单 writer 锁＋journal，冲突不自动取新 token 重试，写结果不明标 `outcome_unknown`。
- **出口**：不访问公共图服务/远程字体图片/AI/云导出；锁定本地执行器只传允许环境与 `ARCHIFY_UPDATE_CHECK_DISABLED=1`；网络 smoke 要求零未登记连接尝试。
- **权限**：owner Peer 不等于文件许可；`DiagramAccessRegistryV1` 另行登记 context/document/output_root，每次 open/save/export 再核路径身份与 scope 代次；工具/UI 不能登记新 root。

## 4. 首个验收动作

- 第一动作：`node --test tests/evidence.test.mjs tests/source-state.test.mjs`，先用合成 snapshot 证明 exact/may/unresolved 保留、`reference≠call`、手工边 annotation、换 snapshot 变 stale、缺身份 unknown；先记录失败用例再实现。
- 随后：`node --test tests/render.test.mjs tests/assets.test.mjs tests/archive.test.mjs` 与 `node tools/render.mjs --fixture --renderer builtin --out ./scratch-output` 验证确定性、来源/版本栏、等价文字、恶意标签不执行、重复 operation 幂等、取消/失败不留可用半包。
- 编辑/保存：`node --test tests/xml.test.mjs tests/import.test.mjs tests/editor-model.test.mjs tests/save.test.mjs tests/paths.test.mjs`；`node tools/editor-smoke.mjs --isolated --fixture` 验证本地编辑旅程（组件级；真实 Host 通道另列 gate）。
- 出口：`node tools/network-smoke.mjs --isolated --renderers builtin`。

## 5. 本轮明确不做/未验证

- 不安装插件到用户 profile、不重启 Harness、不调用真实 Atlas 分析、不下载 Archify/Drawio 构件；T4/T6 的"真实认证 Peer→同 channel→registry→document-store→浏览器 CSP/卸载"仍是外部运行门禁，只能记为待验证，不能以组件测试冒充完整首版。
- 不引入第三方 npm 运行时依赖；`runtime/node.exe` 不入库（避免提交 100MB 二进制），测试使用 PATH 中的 Node ≥24.9，并由 `tools/check-runtime.mjs` 打印实际版本与摘要。
- 可选 Drawio 增强、Archify 执行器保持"未采用"，不影响首版组件交付；按设计，编辑功能本身不可省略，已由自有受限 SVG 编辑器承担。
