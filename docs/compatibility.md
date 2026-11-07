# 06 兼容矩阵与实现偏差记录

更新：2026-11-07。状态：组件级自测完成（`node --test tests/` 全绿），真实 Host 安装/浏览器旅程仍未执行。设计基线 [DIA-DESIGN-2](software-design.md)；本文件记录实际兼容身份、已核对接口、与设计的实现偏差及升级条件。

## 1. 运行基线

| 项 | 实际值 | 证据/说明 |
|---|---|---|
| DeepSeek Harness | `0.2.1-rc.5`（hostProtocolVersion 4） | 只读审计安装包 `E:/dsh/resources/app.asar`（SHA256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915`）与 `desktop-runtime.json` |
| 宿主内嵌 Node | `24.21.0` | `desktop-runtime.json` release 字段 |
| Electron | `44.7.0` | 同上 |
| 测试运行时 | `Node 26.13.0`（win32/x64），`engines.node >=24.9.0` | `node tools/check-runtime.mjs` |
| 运行时依赖 | 无第三方 npm 依赖；只用 Node 标准库与宿主平台模块 | `package.json` 无 dependencies |
| 浏览器 | 未执行 | client bundle 只在 fake module loader 下做结构测试，未在真实 Chromium 验证 CSP/DOM |

## 2. 已核对的宿主接口（只读源码，不 vendor）

| 模块 | 版本 | 采用方式 |
|---|---|---|
| `@deepseek-ai/dsh-client-connection/lib/index.js` | 0.2.1-rc.5，SHA256 `0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684` | Host `ctx.connection.rpc.handle(channel, handler)`；handler `(endpoint, payload, signal, peer)` 返回 `RpcResult {ok:true,value}|{ok:false,error}`（源码 `fullResponse` 直接包 `server-response.result`） |
| `@deepseek-ai/dsh-client-connection/lib/client.browser.js` | 0.2.1-rc.5，SHA256 `dfc3544eb894c74b340a4c4c63a8c125fd2e983df9efed5885712574af994e62` | client `ctx.connection.rpc.call(channel, endpoint, payload, signal)` 返回 `RpcResult`，需先查 `.ok` |
| `@deepseek-ai/dsh-client-ui-layout/lib/client.js` | 0.2.1-rc.5，SHA256 `eb011a7b5699fac7f3ad0aa15408f46a6cf47f79b8cc15db1f81739e81e70587` | `ctx.reflect.provide("layout", ...)`；`main` 为 root keyed slot；`ctx.slots.inject/register` |
| `@deepseek-ai/dsh-client-modules` | 0.2.1-rc.5 | `window.__ModuleLoader__.load({id, factory:(require)=>{...}}) ` 懒 CJS bundle；平台 seed 表含 `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives` 等 |
| `@deepseek-ai/dsh-package-manifest` | 0.2.1-rc.5 | 包声明 `dsh.bundle.patch` + `dsh.client{inject,platform}` |

**证明边界**：这些是"已核接口"，不是"真实 Host 旅程已通过"。安装、激活、浏览器 CSP、卸载后旧 RPC、OS 级出口仍属未验证门禁（见 [实现路线](implementation-route.md) §5、[证据目录](../evidence/README.md)）。

## 3. 与设计的实现偏差（均为已记录的实现选择）

| 偏差 | 原因 | 影响/验证 |
|---|---|---|
| `plugin/client.js` 由 `tools/build-client.mjs` 从 `ui/*.mjs` + 选定 `src/*.mjs` 确定性内联生成；不提交 `.tsx` 构建链 | 本轮不安装 tsdown/TSX；需要离线可复现（`--check` 可验证） | bundle 结构测试通过；真实浏览器未验证 |
| 仓库不提交 `runtime/node.exe` | 100MB 二进制不适合入库，且与宿主 Node24 身份易混 | `runtime/README.md`；测试用 PATH Node，实际版本由 check-runtime 打印 |
| 默认编辑器为自有受限 SVG 编辑器，未采用 dsh-drawioedit / Archify | 未完成 vendor 版本/许可/rc.5 出口审计；设计允许后备 | 见 THIRD_PARTY_NOTICES；增强路径保持待实现 |
| `.drawio` 导出省略 XML 声明；`note.target_ref` 无法写入白名单 XML 属性 | 受限解析与属性白名单 | 导出时警告 `note_target_ref_not_serialized`；overlay JSON 为权威，Host 保存以 JSON 为准 |
| 导出图包 `manifest.files` 列 6 个 payload 文件，`manifest.json` 自身不入列 | 自哈希不可能 | 图包共 7 文件，manifest 记录其余 6 个 sha256 |
| `specDigest` 排除 `generated_at/source_state`，`overlayDigest` 排除 `updated_at` | 让同内容重渲染/重挂 overlay 稳定；语义幂等而非字节幂等 | contracts 测试覆盖；manifest `spec_digest` 使用该值 |
| 证据模式同内容重复渲染：同一 `--out` 下复用同一不可变 artifact（语义 idempotency） | `generated_at` 为真实时间，字节不可复现 | 跨 `--out` 不保证字节一致；fixture 模式固定时钟可字节复现 |
| 文档保存修订 sidecar 带 generation 前缀（`<gen>-<sha>.base.json` 等） | 恢复时无歧义 | store 测试覆盖；XML 字节摘要仍是 DocumentVersion 一部分 |
| registry 的本地路径绑定存于 `registry.local.json`，不进严格 `DiagramAccessRegistryV1` | 严格 schema 不携带原始路径；lookup 每次重核 realpath 身份 | `tools/registry.mjs` 写入；RPC 响应永不泄露路径 |
| `document_id` 限 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`（比通用 id 字符集窄） | 作为文件系统目录名 | store 校验与测试覆盖 |
| 未启用可选 iframe bridge 运行路径（bridge 模块已实现并有测试） | 默认自有编辑器同构建内组件，无需 iframe | T4 验收中的 bridge 负例以组件测试覆盖 |
| 03 事件消费为本地同步模块 `src/events.mjs`（无 Host 事件订阅） | 06 不阻塞于 03 完整实现，用 fixture 验证 | `tests/interop.test.mjs`；真实事件接线属组合门禁 |
| 原位覆盖任意外部文件、跨进程平台级 CAS 未实现 | 设计明确后置；v1 用不可变修订 + 独占创建导出 | `docs/software-design.md` §8；store 单测证明不覆盖 |

## 4. 升级/替换条件

- **宿主升级**：必须在目标 rc 版本重核 §2 的四个接口（RPC handle/call、slots/layout、module loader bundle 格式、package manifest），重跑 `node --test tests/` 与 editor-smoke；未重核前 `dsh.compatibility.dshReleases` 保持 `unknown`，不宣称兼容。
- **引入 Archify/Drawio**：先锁发布字节、依赖闭包、vendor 版本/许可证、rc.5 兼容与完整出口审计；`source-lock.json` 增加 adopted source 与 command，`commands` 非空后 runner/network-smoke 必须重跑；不能降低证据标签或扩大读取范围。
- **升级 schema**：major 升级并给显式转换工具；旧 spec 只读不盲迁移；base 证据永不被 overlay 覆盖。
- **浏览器/安装验收**：按 [实现路线](implementation-route.md) §5 执行；通过前状态保持"组件级已验收，完整首版待 Host 门禁"。
