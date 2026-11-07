# 06 · 本地图示（dsh-local-diagrams）

本仓库是 DeepSeek Harness 能力 06 的独立实现：**把有来源的代码关系变成离线讲解图，并在本地受限编辑器里查看、拖拽、注解和版本化保存**。生成/讲解可独立使用（skill + CLI，无 Host 依赖）；本地编辑以 rc.5 Host/client 插件提供。手改图始终是注释，不会回写编译事实。

设计依据：[软件设计](docs/software-design.md)（DIA-DESIGN-2）、[产品形态](docs/product-form.md)（DIA-PF-1）、[实现路线与来源](docs/implementation-route.md)、[内部接口合同](docs/interfaces.md)。

## 状态

- 设计：DIA-DESIGN-2（2026-11-07），已冻结可编码接口。
- 实现：编码完成（DeepSeek Harness 0.2.1-rc.5 薄适配版本）；组件级自测见 [evidence/README.md](evidence/README.md) 与 [最终运行摘要](evidence/final-summary.md)。
- 本轮实际运行（2026-11-07，Node v26.13.0 win32/x64，合成 fixture、临时目录、无网络）：
  - `node --test tests/` → **340 tests / 340 pass / 0 fail / 0 skip**（25 个测试文件，含集成旅程）。
  - `node tools/render.mjs --fixture` 与 `--evidence ...` → `saved`、7 文件图包、`remote_refs=0`；fixture 重复渲染 manifest 摘要一致（语义幂等）。
  - `node tools/network-smoke.mjs --isolated --renderers builtin` → `attempted_count=0`（守卫覆盖 fetch/WebSocket/net/dns/http/https/http2 等）。
  - `node tools/editor-smoke.mjs --isolated --fixture` → 12/12 检查通过、13 次服务级 RPC、0 未登记网络尝试（transport double，非真实 HTTP Host）。
  - `node tools/build-client.mjs --check` → 与 `ui/` 源码同步；`node tools/validate.mjs` → 7/7 通过；`node tools/check-runtime.mjs` → 版本/宿主身份门槛通过。
- 交付边界（必须如实理解）：
  - **已自测**：schema/证据/stale、确定性布局与 SVG/HTML、原子图包、受限 XML 与外部导入降级、编辑命令/undo/redo、文档版本/冲突/journal、RPC 服务与 client bundle 的组件级行为。
  - **未自测（外部门禁）**：未安装到用户 Harness profile，未在真实浏览器验证 main 面板 CSP/DOM 旅程，未验证真实登录 Peer→channel→registry→document-store 全链路，未做 OS 级全进程出口审计。按设计，这些通过前**不能宣称完整首版在真实 Host 可用**。
  - 未运行 Atlas doctor/索引；未下载或执行 Archify/Drawio 构件（见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)）。

## 两个入口

### 1) 生成/讲解（无 Host 依赖）

```powershell
node tools/render.mjs --fixture --renderer builtin --out .\scratch-output
```

产物目录包含 `index.html`、`diagram.svg`、`diagram-spec.json`、`manifest.json`、`evidence.json`、`diagram.drawio`、`annotations.json`；`index.html` 断网可看，含来源/版本栏、exact/may/unresolved 图例、截断/未解析提示和文字等价表。CLI 不读凭据、不联网、不调用模型。

Agent 使用说明见 [skills/explain-local-diagram/SKILL.md](skills/explain-local-diagram/SKILL.md)。

### 2) Harness 内本地编辑器（插件）

- Host 半：`plugin/index.mjs`，注册认证 RPC 通道 `/local-diagrams`（`document.open/save/export`、`operation.get`、`session.close`），单 writer 保存到不可变修订。
- Browser 半：`plugin/client.js`（rc.5 懒 CJS bundle），在 `main` 槽注册 `local-diagrams` 面板；通过 `ctx.connection.rpc.call` 访问 Host，SVG 白名单渲染 + Pointer Events 拖拽 + 文字注解 + annotation 边 + undo/redo + 冲突视图 + 导出。
- 安装：本包声明 `dsh.bundle.patch`（`cordis.patch.yml`）与 `dsh.client`；**本轮未执行安装/重启**。真实 Host 验收命令见 [实现路线](docs/implementation-route.md) 第 5 节。

## 常用命令

```powershell
node --test tests/                          # 全部组件测试
node tools/render.mjs --fixture --renderer builtin --out .\scratch-output
node tools/network-smoke.mjs --isolated --renderers builtin
node tools/editor-smoke.mjs --isolated --fixture
node tools/build-client.mjs --check         # client bundle 与 ui/ 源码同步
node tools/check-runtime.mjs                # 运行时/宿主身份
```

## 目录

```text
src/contracts.mjs        严格 DiagramSpec/Overlay/Manifest/DocumentVersion 校验与 digest
src/evidence.mjs         Atlas 证据子集 -> 规范图（保留 certainty）
src/source-state.mjs     current/stale/unknown 身份比较
src/layout.mjs           稳定分层布局（SCC + 最长路 + 重心排序）
src/render-svg.mjs       自有 SVG，全部文本 escape、元素/属性白名单
src/render-html.mjs      离线 HTML、CSP、图例与文字等价表
src/assets.mjs           资源清单与离线策略校验
src/archive.mjs          图包原子提交、幂等、manifest
src/drawio/xml.mjs       受限 XML 子集 tokenizer/序列化
src/drawio/import.mjs    外部 XML -> conceptual overlay（未知形状 unsupported）
src/editor/model.mjs     EditorModelV1 与完整命令 union/undo/redo
src/editor/bridge.mjs    iframe 消息 v1、origin/source/nonce、去重
src/editor/access.mjs    DiagramAccessRegistryV1 与路径身份
src/editor/document-store.mjs 单 writer、不可变修订、journal、草稿
src/plugin/service.mjs   RPC 业务分发与固定 reason_code
src/runner.mjs           锁定本地执行器（固定路径/环境/超时/子进程树）
plugin/index.mjs         rc.5 Host 薄适配
plugin/client.js         构建产物（由 ui/ 生成，勿手改）
ui/                      client 侧纯函数/模型
tools/                   render / validate / network-smoke / editor-smoke / build-client / registry / check-runtime
tests/                   node:test 与合成 fixture
docs/                    设计、产品形态、实现路线、接口合同、机制说明、兼容矩阵
evidence/                实际运行记录（JSON/TAP）
```

## 边界（与设计一致）

- 所有关系标注 exact/may/unresolved/unknown；`reference` 不会因为连到函数就被称为 `call`；概念图和外部导入不伪造代码事实。
- 禁止公共图服务、远程字体/图片、URL 导入、AI/云导出与自动更新；HTML CSP 与 SVG 白名单只是进程内一层，OS 级出口仍需真实 Host 验收。
- `.drawio` 往返使用受限 mxGraph 子集；外部未知高级形状显示 `unsupported`，不删字段强存；导入永不提升来源等级。
- 保存为 `documents/<document_id>/revisions/...` 不可变修订；冲突保留双方、不自动取最新版本覆盖；原位覆盖任意外部文件后置。
- Apache-2.0（见 [LICENSE](LICENSE)）。

## 与工作区的关系

本仓库从 `E:\dsh\plugin\06-local-diagrams` 导出；原工作区的八能力共同约束与流程指南以 [参考副本](docs/references/) 保留（副本仅便于独立仓库阅读，原工作区文件为权威）。
