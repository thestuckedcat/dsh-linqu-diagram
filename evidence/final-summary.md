# 06 最终自测摘要（组件级，评审修复后）

日期：2026-11-07。运行时：Node `v26.13.0`（win32 x64，PATH 中 node；仓库未提交 node 二进制，见 [runtime/README.md](../runtime/README.md)）。宿主基线：DeepSeek Harness `0.2.1-rc.5`（app.asar SHA256 `e1b6f25f…c6915`，内嵌 Node 24.21.0 / Electron 44.7.0），只读核对，未安装。全部测试使用合成 fixture、`mkdtemp` 临时目录、断网条件；未读取用户凭据、未调用模型、未访问真实 Atlas/Archify/Drawio。

## 1. 实际执行的命令与结果

| # | 命令 | 结果 | 证据文件 |
|---|---|---|---|
| 1 | `node --test tests/` | exit 0；**tests 349 / pass 349 / fail 0 / skipped 0**（25 个测试文件，含集成旅程与 `review-regressions`） | [final-test-run.json](final-test-run.json) |
| 2 | `node tools/render.mjs --fixture --renderer builtin --out ./scratch-output` | exit 0；`status=saved`、7 文件图包、`checks{files:7,remote_refs:0}`、manifest digest `85e992ed…1eac`、`evidence_verification=structural-only` | [fixture-render.json](fixture-render.json) |
| 3 | 同 #2 再跑一次到另一个 out 根 | exit 0；manifest digest 与 #2 相同（确定性/语义幂等） | 本文件记录（输出已清理） |
| 4 | `node tools/render.mjs --evidence tests/fixtures/snapshot/evidence-subset.json --source-identity tests/fixtures/snapshot/source-identity.json --current-identities tests/fixtures/snapshot/current-identities.json --renderer builtin --out ./scratch-output` | exit 0；`mode=evidence`、`source_state=current`、nodes 5 / edges 4、7 文件、`remote_refs=0`、manifest `517fdb86…ac90`；warnings 含 `coverage.complete=false`、`unresolved_count=1`、`structural-only` 解释 | [evidence-render.json](evidence-render.json) |
| 5 | `node tools/render.mjs --import-drawio tests/fixtures/drawio/external-basic.drawio --renderer builtin --out ./scratch-output` | exit 0；`mode=conceptual`、`overlay_items=4`、7 文件、`remote_refs=0`、manifest `7cd3172a…2d17`；压缩 XML 为 `UNSUPPORTED`/exit 1（由测试覆盖） | [import-drawio.json](import-drawio.json) |
| 6 | `node tools/network-smoke.mjs --isolated --renderers builtin` | exit 0；`attempted_count=0`、`unregistered_attempts=0`，7 文件资源/manifest/HTML 校验通过 | [network-smoke.json](network-smoke.json) |
| 7 | `node tools/editor-smoke.mjs --isolated --fixture` | exit 0；`checks 12/12`、13 次服务级 RPC、`attempted_count=0`、`unregistered_rpc_endpoints=[]` | [editor-smoke.json](editor-smoke.json) |
| 8 | `node tools/build-client.mjs --check` | exit 0；`plugin/client.js` 与 `ui/` 源码同步 | [client-build-check.json](client-build-check.json) |
| 9 | `node tools/validate.mjs` | exit 0；**ok=true / pass=7 / fail=0**（修复评审 R-03 假绿后） | [schema-validate.json](schema-validate.json) |
| 10 | `node tools/check-runtime.mjs` | exit 0；Node 版本满足 `>=24.9`，打印宿主身份与来源采用状态（0 adopted / 5 not_adopted） | [runtime-check.json](runtime-check.json) |

补充（由 #1 测试覆盖）：`--verify-evidence-roots` 正/负例（缺失文件 → `INVALID_SPEC`）、`--conceptual`、fixture 重复渲染摘要一致、`network-smoke --self-test-guard` 7/7 守卫探针阻断、真实 CLI artifact → `document.open` 非空坐标 → 编辑保存/冲突/重开、外部 XML 假 exact 元数据降级、图包字节篡改不返回 saved。

## 2. 这些证据证明什么

- 证明：模块合同、确定性、证据标签保留（含可选内容 verifier 与 structural-only 标注）、离线资源边界、受限 XML、编辑命令、版本/冲突/journal、scope 代次撤销、RPC 服务（owner/文档绑定/脱敏）与 client bundle 结构在**合成输入 + 临时目录**下按设计工作；测试实际运行且全绿。
- 未证明：真实 Host 安装/激活、真实认证 Peer→HTTP channel→registry→document-store 全链路、浏览器实际 CSP/DOM/Pointer Events 旅程、卸载后旧 RPC 拒绝、OS/Chromium 级出口、真实 Atlas 证据质量、真实 Archify/Drawio 兼容、用户数据上的性能与体验。

## 3. 保留的限制

- network-smoke/editor-smoke 的守卫是**本 Node 进程 JS 入口级**审计，不是 Chromium/原生子进程/OS 级证明。
- editor-smoke 用 transport double 直连 `createLocalDiagramsService().handle`，未序列化真实 RpcResult HTTP 外壳，未启动 Cordis fiber。
- client bundle 在 fake `window.__ModuleLoader__` + fake 平台 require 下物化；React 未真实渲染面板，拖拽以纯函数/模拟事件验证。
- 证据内容核验默认 `structural-only`；`--verify-evidence-roots` 只校验文件存在/行号/根内路径，不重算 Atlas `content_digest` 语义。
- 未安装、未重启 Harness；按设计，完整首版交付仍以真实 Host 门禁通过为前提。
- 独立评审的 11 项 blocker/major 已修复并有回归测试；真实 Host/浏览器/OS 门禁按评审结论保持未验证，见 [docs/review.md](../docs/review.md) 第 8 节。
