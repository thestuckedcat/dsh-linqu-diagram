# 06 实现内部接口合同（编码协作基线）

本文件是 DIA-DESIGN-2 的编码落地接口，供并行实现与独立评审使用。**实现必须服从本表**；修改接口先改本文件与设计，并跑受影响测试。所有模块为 ESM（`.mjs`，浏览器侧另见 §11），不引入第三方运行时依赖。

通用约定：

- 校验函数返回 `{ok:true, value}` 或 `{ok:false, errors:[{path,keyword,message}]}`，不抛异常；业务入口把失败映射为稳定 `code`（见 `src/limits.mjs` `CODES`）。
- 所有外部输入先做 schema 校验，再做语义校验。字符串是纯文本（禁止 HTML/脚本/URL 语法作为数据解释），ID 1–128 字符，计数/坐标为有限整数。
- 每个模块不得隐式联网、读凭据、调用模型服务或读取登记根之外的路径。时间统一 UTC ISO 字符串，来源可注入 `clock`（默认 `() => new Date().toISOString()`），测试不得依赖真实时钟。
- 基础模块已存在：`src/limits.mjs`（`LIMITS`, `CODES`）、`src/errors.mjs`（`DiagramError`, `fail`, `safeInteger`）、`src/schema.mjs`（`validateSchema`, `assertSchema`）、`src/canonical.mjs`（`canonicalJson`, `sha256Hex`, `digestOf`, `canonicalEqual`）。

## 1. `src/contracts.mjs`，`schemas/*.json`（owner: contracts）

导出：

```js
export const SCHEMAS = { source_identity, evidence_ref, diagram_spec, annotation_overlay, artifact_manifest, document_version, access_registry, editor_model, rpc_request, rpc_response };
export function validateDiagramSpec(value) -> {ok, value|errors}
export function validateOverlay(value) -> {ok, value|errors}
export function validateManifest(value) -> {ok, value|errors}
export function validateDocumentVersion(value) -> {ok, value|errors}
export function validateAccessRegistry(value) -> {ok, value|errors}
export function validateEditorModel(value) -> {ok, value|errors}
export function validateComposite(spec, overlay) -> {ok, value|errors}  // 语义：端点/目标/类型/唯一 layout/visibility/annotation 不变量
export function specDigest(spec) -> sha256 hex            // 规范化 base spec
export function overlayDigest(overlay) -> sha256 hex
export function manifestDigest(manifest) -> sha256 hex
export function documentVersionDigest(version) -> sha256 hex
export function emptyOverlay({diagram_id, base_spec_digest, now}) -> AnnotationOverlayV1
export function text(value, max, name) -> string          // 纯文本 + 长度（含控制字符拒绝）
export function id(value, max, name) -> string
```

`schemas/*.json` 是权威合同（`additionalProperties:false`）；可用 `tools/validate.mjs` 把 fixture 与 schema 对跑。JS schema 对象与 JSON 文件必须一致（测试同时加载两者比对）。

语义不变量（`validateComposite`）：

- `overlay.diagram_id === spec.diagram_id`、`overlay.base_spec_digest === specDigest(spec)`。
- overlay item id 唯一且不与 base 节点/边 id 碰撞；新增项 id 以 `ann:` 前缀（base 实体不受此限）。
- `annotation_edge.from/to` 指向当前 spec/overlay 的有效可见节点；`note/layout/visibility.target_ref` 指向当前文档实体；`annotation_edge` 无 evidence。
- base 证据节点/边只可 layout/visibility 覆盖（`layout` 每目标至多 1、`visibility` 每目标至多 1）；证据图（mode=evidence）禁止 `annotation_node`。
- 概念图（mode=conceptual）所有 base 边 `origin=annotation` 且 `certainty=unknown`，`sources` 可为空。

## 2. `src/evidence.mjs` + `src/source-state.mjs`（owner: evidence）

```js
// evidence.mjs
export function toDiagram(input, policy = {}) -> {status:'ok', spec} | {status:'denied'|'invalid', code, errors?}
// input: {source_identity, evidence_subset, conceptual_input?}
// evidence_subset: {atlas_version?, nodes:[{id,label,kind,evidence_refs,description}], edges:[{id,from,to,kind,certainty,label,evidence_refs,explanation}], coverage?}
// conceptual_input: {title, scope_ref, nodes:[{id,label,kind}], edges:[{from,to,kind,label,description}]}
// policy 额外：verify_evidence?: (ref) => {ok:true}|{ok:false,reason}; 未提供时 coverage 记 structural-only
export function emptyConceptualSpec(input, policy = {}) -> DiagramSpecV1
export function rendererRef(policy = {}) -> string   // 默认 'builtin:renderer-v1'
// source-state.mjs
export function validateSource(spec, currentIdentities) -> {state:'current'|'stale'|'unknown', changed_refs:string[], reasons:string[]}
export function compareIdentity(known, current) -> {equal:boolean, changed_refs:string[], reasons:string[]}
```

规则：`toDiagram` evidence 模式逐边保留 `certainty`，`reference` 不得升级为 `call`；`origin=evidence` 且 `certainty=exact` 的边必须有结构合法的 `evidence_refs`（repo 已声明、相对安全路径、行号区间、非空 digest），且 certainty 不得高于 evidence_refs 来源级别（policy 可注入 `max_certainty_by_evidence`，默认 exact 证据→exact、其余不提升）。**内容真实性不靠 schema 保证**：默认只结构校验并在 `coverage.notes` 标记 `structurally validated only`；`policy.verify_evidence` 被提供时逐 ref 调用，失败整图 `INVALID_SPEC`。生成结束调用 `layoutDiagram` 并把确定性 positions 写入 `spec.layout`（渲染、`.drawio`、编辑器都基于真实坐标）；spec.sources 的 `root_ref` 存为 `root-ref:<16 hex>` 不透明引用，不持久化本机路径。手工/概念边 `origin=annotation`。ID 缺失时由 label+scope 生成局部 ID 并加 `local:` 前缀，不称为稳定代码实体。`coverage.complete` v1 恒 `false`。超限返回 `invalid`/`LIMIT_EXCEEDED`，或按 policy `truncate:true` 明确截断并在 `coverage.truncated/omitted_*` 记录。`source_state` 生成时按 `currentIdentities`（缺省则 `unknown`）计算；`validateSource` 只比较身份，不比较代码关系。

## 3. `src/source-lock.mjs` + `src/runner.mjs`（owner: outlet）

```js
// source-lock.mjs
export function parseSourceLock(text) -> {ok, lock|errors}   // 严格 schema（source-lock.schema.json）
export function validateSourceLock(lock, {root, requireAdoptionProof=false}) -> {ok, errors[]}
export function verifyLockedFiles(lock, root) -> {ok, files:[{path,sha256,matches}], errors[]}
export function executorFor(lock, command_id) -> {executable_ref, args_template, env_fixed} | null
// runner.mjs
export function runLockedCommand(source_lock, command_id, {root, args=[], cwd, timeout_ms, signal, allowed_env={}}) -> Promise<{status:'ok'|'denied'|'failed'|'timeout'|'cancelled', exit_code?, stdout?, stderr?, code?}>
export function assertNoRemoteRefs(text) -> {ok, errors[]}   // 资源/HTML/XML 文本中的 http(s)/ws/远程字体图片
```

`runLockedCommand` 固定 `shell:false`、`windowsHide:true`、环境白名单（仅 `PATH`/`SYSTEMROOT` 等必要项 + `env_fixed` + 调用方 `allowed_env`，固定 `ARCHIFY_UPDATE_CHECK_DISABLED:'1'`）、超时/取消杀进程树、stdout/stderr 限长。未在 source-lock 登记的 command 返回 `denied`。

## 4. `src/layout.mjs`（owner: render）

```js
export function layoutDiagram(spec, {direction='LR'} = {}) -> {algorithm:'layered_v1', direction, positions:[{node_id,x,y,width,height}]}
export function routeEdges(spec, layoutResult) -> [{edge_id, points:[{x,y}], back:boolean, self_loop:boolean}]
export function layoutDigest(layoutResult) -> string
```

确定性要求：节点按稳定 ID 排序；有向边 Tarjan SCC；SCC DAG 最长路分层；同层两次上游重心扫描 tie 按 ID；节点最小 160×64、label 按字符折行；层间 96/同层 32；坐标取整数；相同 spec/direction 输出逐字节一致；自环/回边独立折线路径。超限先拒绝（`limit` 参数注入）或按 policy 截断并标 `coverage.truncated`（由调用方记录，layout 不静默丢边）。

## 5. `src/render-svg.mjs`、`src/render-html.mjs`、`src/assets.mjs`、`src/archive.mjs`（owner: render）

```js
// render-svg.mjs
export function renderSvg(spec, {overlay, layout} = {}) -> {svg, text_equivalent:[{id,text}], legend:[{kind,label,count}], hidden:{nodes,edges,count}}
export function escXml(text) -> string
// render-html.mjs
export function renderHtml({spec, overlay, layout, svg, text_equivalent, legend, hidden, manifest, renderer_ref, source_state}) -> {html, script_hash}
export function cspFor(script_hash) -> string
// assets.mjs
export function buildResourceManifest(files, {root}) -> {ok, manifest|errors}   // 每个文件 sha256/size/media_type
export function verifyResourceManifest(manifest, {root, limits}) -> {ok, errors[]}
export function verifyAtlasArtifact(htmlPath, {allowed_root}) -> {ok, errors[]} // 已有离线 HTML 资源校验
export function offlinePolicy() -> {network:'none', allowed_origins:[]}
// archive.mjs
export function renderLocal({spec, overlay, output_ref, renderer='builtin', expected_output_revision=null, operation_id}, caller, signal) -> Promise<{status:'saved', artifact_ref, manifest_digest}|{status:'conflict'|'denied'|'cancelled'|'failed'|'outcome_unknown', code}>
export function computeArtifactManifest({artifact_id, spec, overlay, files, renderer_ref, created_at}) -> ArtifactManifestV1
export function artifactFileNames() -> ['index.html','diagram.svg','diagram-spec.json','manifest.json','evidence.json','diagram.drawio','annotations.json']
```

SVG 只允许白名单元素 `svg,g,rect,path,line,polyline,text,tspan,title,desc` 与固定安全属性；所有文本 XML 转义；不生成 `foreignObject/script/style/image/a href/on*`。HTML 内联脚本固定、无 fetch/WebSocket/eval；CSP `default-src 'none'; img-src data:; style-src '<sha256>'; script-src '<sha256>'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。HTML 必须有来源/版本栏、置信图例、未解析/截断提示、文字等价表、footer（source_state/mode/generated_at/renderer）。图包按 §4 七文件输出；注释为空也写 `annotations.json`。原子提交：staging 目录按 operation_id、写全→fsync→同卷 rename 到不可变 `artifact_id` 目录；同 operation 同 spec 返回同 artifact，不同 spec 拒绝；取消在提交前清 staging；疑似提交后取消返回 saved 并说明，无法确认 rename 标 `outcome_unknown`。

## 6. `src/drawio/xml.mjs`、`src/drawio/import.mjs`（owner: drawio）

```js
// xml.mjs
export function parseXmlRestricted(text, {limits} = {}) -> {ok, root} | {ok:false, code:'INVALID_XML', errors[]}
// root: {name, attributes:{k:v}, children:[node|{text}], text}
export function serializeMxGraphModel(model) -> string     // model: {root_cells:[{id,parent,value?,style?,vertex?,edge?,source?,target?,visible?,geometry?}], layers:[...]}
export function exportDrawio({spec, annotation_overlay}, policy = {}) -> {xml, warnings}
export function parseDrawioXml(text, {limits} = {}) -> {ok, document:{cells, layers}} | {ok:false, code, errors}
export function canonicalMxGraph(model) -> string          // 规范语义比较用
// import.mjs
export function importExternalDrawio(text, {limits, scope_ref, title} = {}) -> {status:'ok', base_spec, overlay, warnings} | {status:'unsupported'|'invalid', code, errors}
```

XML 边界：禁 DOCTYPE/ENTITY/CDATA/PI/注释/命名空间声明/重复属性；只认 UTF-8、单双引号属性、5 种预定义实体与合法 Unicode 数值实体；先限字节/深度/节点数；解析结束要求空栈且唯一根。drawio 只认 `mxfile/diagram/mxGraphModel/root/mxCell/mxGeometry/mxPoint/Array` 白名单与固定父子关系；压缩 diagram 内容拒绝（提示先导出未压缩 XML）；属性白名单 `id,value,style,parent,source,target,vertex,edge,visible,x,y,width,height,as` 及本工具 `data_*`（`data_origin,data_certainty,data_base_digest,data_diagram_id,data_cell_kind`）；style 只允许颜色/字号/线型/折线/形状枚举，拒绝 `image/link/url/fontFamily 远程值/javascript:/data:/file:/http(s):`。导出：root cells `0` + 三层 `layer-base/layer-annotations/layer-notes`，base cell ID `base:` 前缀、overlay `overlay:` 前缀，ann cell 带 `data_origin='annotation',data_certainty='unknown'`，隐藏项保留在 JSON、XML 标 visible=0。外部导入一律按 conceptual：几何/纯文本/端点映射到 overlay annotation_node/edge + 空 conceptual base；`data_*` 只显示不提升来源；未知高级形状 `unsupported`，不删字段强存。

## 7. `src/editor/model.mjs`、`src/editor/bridge.mjs`（owner: drawio）

```js
// model.mjs
export function createEditorModel(spec, overlay?) -> EditorModelV1
export function executeEdit(model, command, options = {}) -> {status:'ok', model, inverse} | {status:'stale'|'invalid', code, errors?}
export function undo(model) -> {status:'ok', model, inverse} | {status:'invalid', code}
export function redo(model) -> {status:'ok', model, inverse} | {status:'invalid', code}
export function rebaseOverlay(spec, overlay) -> {overlay, orphaned}  // 重新生成后按稳定 ID 重挂；丢失目标保留 orphaned
export function serializeEditorModel(model) -> string
// bridge.mjs
export function createChannelNonce() -> string             // 128-bit hex
export function createBridgeGuard({editor_origin, editor_window, editor_session_ref, nonce}) -> {accept(event) -> {ok, message}|{ok:false, code}, reset(), seenCount()}
export function validateBridgeMessage(message, {editor_session_ref, nonce}) -> {ok, message|{ok:false, code, errors}}
export function messageDigest(type, payload) -> string
```

命令 union 严格按设计 §7：`move_node, set_note, add_annotation_node, set_annotation_node, add_annotation_edge, remove_annotation, remove_annotation_node, set_visibility, undo, redo`；payload `additionalProperties:false`。成功推进 `draft_revision`；`inverse` 含 `before_revision,after_revision,restore_items,remove_ids,restore_selection`，只内部使用；`undo/redo` 校验 revision 与复合 patch；一次节点删除及关联项是一条复合历史；新编辑清 redo；历史最多 100 条/2MiB。`remove_annotation` 只接受 note/annotation_edge；证据 base 节点/边只 layout/visibility，不物理删除。`set_visibility` 只 base 实体；ann edge 端点必须有效可见节点，永远 annotation/unknown、无 evidence。`rebaseOverlay` 不静默丢项，丢失目标进入 `orphaned_annotations`。

`bridge`：校验 `event.origin === 锁定 editor origin`、`event.source === 该 iframe.contentWindow`、128-bit `channel_nonce`、每类型严格 schema/大小、未知 type 拒绝；`nonce` 只在内存握手、不写 URL/log；重复 `message_id` 去重、同 ID 不同正文拒绝；save operation 绑定确切 XML 与 overlay 摘要。

## 8. `src/editor/access.mjs`（owner: store）

```js
export function createAccessRegistry(initial = {schema_version:1, revision:0, contexts:[], documents:[], output_roots:[]}) -> AccessRegistry
// AccessRegistry: { snapshot(), registerContext(entry), registerDocument(entry), registerOutputRoot(entry), revoke({kind, ref}), lookupContext(ref, expectedScopeGeneration), lookupDocument(ref, expectedScopeGeneration), lookupOutputRoot(ref, expectedScopeGeneration), exportToJson() }
export function pathIdentityDigest(realPath) -> string     // realpath + lstat/重解析点检查 + 平台身份
export function isWithinRoot(rootRealPath, candidateRealPath) -> boolean
export function assertPathAllowed(rootRealPath, candidateRealPath) -> {ok, real_path|errors}  // 拒绝 junction/reparse/UNC/越根
export function verifyDocumentEntry(entry) -> {ok, errors[]} // 每次 lookup 时重新核路径身份/scope 代次/active
```

`DiagramAccessRegistryV1` 按设计 §9；`documents[].mode` 为 `read|edit`，`output_roots[].identity_digest`。工具、08 入口与普通 UI RPC 不能登记新 root；登记由本地可信 CLI（`tools/registry.mjs`）完成。测试用临时目录，制造 junction/符号链接的负例在 Windows 用 `mklink /J`（不可用则 skip 并明确记录）。

## 9. `src/editor/document-store.mjs`（owner: store）

```js
export function createDocumentStore({data_root, registry, clock, limits}) -> Store
// Store: { openDocument({document_ref, expected_scope}, caller) -> {status:'opened', document_id, xml, base_spec, overlay, version, editor_session_ref, channel_nonce, warnings} | {status:'denied'|'unsupported'|'unavailable', code},
//          saveDiagram({document_id, editor_session_ref, expected_version, xml, overlay, operation_id}, caller, signal) -> {status:'saved', version} | {status:'conflict', current_version, draft_ref} | {status:'denied'|'invalid'|'cancelled'|'outcome_unknown', code},
//          exportArtifact({document_id, version, output_ref, format}, caller) -> {status:'exported', artifact_ref, sha256, size_bytes} | {status:'conflict'|'denied'|'invalid', code},
//          getOperation({operation_ref}, caller) -> {state:'pending'|'revision_written'|'saved'|'failed'|'unknown', version?, reason_code?},
//          closeEditorSession({editor_session_ref}, caller) -> {closed:boolean},
//          snapshot() }
```

物理策略（设计 §8）：本工具独占数据根下 `documents/<document_id>/revisions/<generation>-<sha>.drawio`（同时写 `<sha>.base.json` / `<sha>.overlay.json` / `<sha>.manifest.json` 并锁 manifest），`pointer.json` 指向当前 generation；`journal.jsonl` 顺序 `prepared→revision_written→pointer_updated→saved`；草稿 `drafts/<session>/<draft_digest>.xml` 保留最近 3 份。`openDocument` 只读源 artifact（`index.html/diagram-spec.json/annotations.json/diagram.drawio/manifest.json`）建立 generation 0；编辑会话绑定 caller+scope+document_id+generation，内存 TTL 1 小时，撤权/停用即失效。`saveDiagram` 单 writer 锁（进程内按 document_id），`expected_version` 必填且含 content hash/路径身份/generation；冲突返回 `current_version` 与草稿引用，不自动取最新 token 重试；写临时文件→fsync→临界区复核→原子 replace→父目录持久化；`operation_id+document_id+expected_version+xml_digest+overlay_digest` 幂等，同 operation 不同内容拒绝；崩溃后按 journal 恢复；`outcome_unknown` 只返回检查状态/导出草稿，不盲重发。`exportArtifact` 只新建不存在目标（exclusive create），存在返回 `conflict`；格式 `drawio|json|svg` 重新校验/序列化。

## 10. `src/plugin/service.mjs` + `plugin/index.mjs`（owner: plugin）

```js
// service.mjs
export function createLocalDiagramsService({registry, store, clock, limits}) -> {
  handle(endpoint, payload, signal, peer) -> Promise<RpcResult>,   // RpcResult = {ok:true,value:BusinessResponse}|{ok:false,error:{code,message,details?}}
  dispose() -> Promise<void>
}
export function normalizeBusinessResponse(result) -> BusinessResponse  // 固定 code 映射，杜绝原文/stack/路径外泄
export const ENDPOINTS = ['document.open','document.save','document.export','operation.get','session.close'];
// 端到端 input 关键字段（RPC 外壳 input，闭合校验）：
//   document.open    {document_ref}
//   document.save    {document_id, editor_session_ref, expected_version, xml, overlay}
//   document.export  {document_id, version, output_ref, format}
//   operation.get    {operation_ref, document_id}          // R-10：绑定所属文档
//   session.close    {editor_session_ref, document_id}     // R-10：绑定所属文档
// plugin/index.mjs
export const name = 'local-diagrams';
export const inject = ['connection'];
export function apply(ctx) -> void
```

`plugin/index.mjs` 只做 rc.5 薄适配：`ctx.connection.rpc.handle('/local-diagrams', (endpoint, payload, signal, peer) => service.handle(...))`，注册归 fiber（`ctx.effect`/返回值），卸载时撤销 editor sessions 并解除 channel；不接受 client 自造 grant，`peer.principal.kind==='owner'` 才处理。请求外壳 `{schema_version:1, operation_id, context_ref, expected_scope_generation, view_epoch, input}`；响应闭合 union `{schema_version, operation_id, view_epoch, scope_generation, status:'ok', data}` 或同外壳加 `status:'denied'|'stale'|'invalid'|'conflict'|'unavailable'|'failed', reason_code`；异常一律固定 `INTERNAL_FAILURE`，不返回 document/store/output 真实路径（base spec 的 `root_ref` 为不透明 `root-ref:<digest>`）、XML 原文、stack、配置。`document.save` 先用自己的 base 校验 overlay（含 orphaned），再确定性生成 canonical XML，把 client XML 解析为白名单结构后与 canonical 语义比较，不一致 `INVALID_OVERLAY`。`document.open` 返回的 base_spec 已带非空确定性 layout positions。

## 11. `plugin/client.js`、`ui/*.mjs`、`tools/build-client.mjs`（owner: plugin）

默认自有编辑器不引入 iframe；client bundle 是 rc.5 client 模块格式的**懒 CJS**：`window.__ModuleLoader__.load({id:'dsh-local-diagrams', factory:(require)=>{...; return module.exports}})`。基线平台模块可直接 `require`：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`。client 插件导出 `{name, inject:['slots','layout','connection'], apply(ctx)}`；注册 `ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'local-diagrams'}, Panel))`，通过 `ctx.connection.rpc.call('/local-diagrams', endpoint, payload, signal)` 取 `RpcResult`（先查 `.ok`，再 validate `.value`）。

`ui/` 放可 Node 单测的纯函数/模型（view-model、drag/键盘命令映射、客户端 XML 组装、冲突视图状态）；`tools/build-client.mjs` 把 `ui/` 与 `src/` 中被选中的纯模块内联成 `plugin/client.js`（确定性输出，`--check` 验证与源码同步），因为本轮不安装 tsdown/TSX 构建链。Bundle 必须只输出白名单 SVG/DOM，不 `eval`/`new Function`/`fetch`/WebSocket；dragging 用 Pointer Events + pointer capture，pointerup 提交一条命令；键盘方向键 8px、Shift 1px；提供表单坐标替代拖拽。

## 12. 测试与工具命令（每个 owner 交付自己的测试）

- `node --test tests/` 必须全绿；单文件测试文件名：`tests/evidence.test.mjs`、`source-state.test.mjs`、`source-lock.test.mjs`、`runner.test.mjs`、`layout.test.mjs`、`render.test.mjs`、`assets.test.mjs`、`archive.test.mjs`、`xml.test.mjs`、`import.test.mjs`、`editor-model.test.mjs`、`bridge.test.mjs`、`access.test.mjs`、`save.test.mjs`、`paths.test.mjs`、`journal.test.mjs`、`service.test.mjs`、`plugin-index.test.mjs`、`client-bundle.test.mjs`、`descriptor.test.mjs`、`interop.test.mjs`、`integration.test.mjs`、`review-regressions.test.mjs`。最终计数见 `evidence/final-test-run.json`。
- 工具：`tools/validate.mjs`（schema/fixture 校验）、`tools/render.mjs`、`tools/network-smoke.mjs`、`tools/editor-smoke.mjs`、`tools/build-client.mjs`、`tools/check-runtime.mjs`、`tools/registry.mjs`、`tools/record-evidence.mjs`（把实际执行的命令写成 `evidence/*.json`）。
- 测试不得写真实用户目录、不得联网、不得依赖真实时钟/随机；临时目录用 `node:fs.mkdtemp`。证据记录写到 `evidence/`（JSON/TAP，含命令、exit、pass/fail/skip、limitations）。

## 13. 实现期增量与已知偏差

编码完成后新增/调整的内容（详细偏差与理由见[兼容矩阵](compatibility.md)）：

- 新增 `src/events.mjs`（03 事件消费：去重、generation 跳号、workspace 恢复→stale、会话事件只清关联；`artifactRefFor` 供 04/08 引用）与 `tests/interop.test.mjs`。
- `specDigest` 不含 `generated_at/source_state`，`overlayDigest` 不含 `updated_at`；`manifest.files` 记录 6 个 payload 文件（`manifest.json` 无法自哈希）；证据模式图包按语义幂等（同输入重复渲染复用同一 artifact）。
- `.drawio` 导出省略 XML 声明，`note.target_ref` 不能写入白名单属性（导出警告，overlay JSON 权威）。
- document store 修订 sidecar 文件名带 generation 前缀；`document_id` 限制为文件系统安全字符集；registry 的本地路径绑定存于 `registry.local.json`，严格 `DiagramAccessRegistryV1` 视图不携带原始路径。
- `plugin/client.js` 是 `tools/build-client.mjs` 的确定性构建产物（不是 tsdown/TSX），bundle 内联 `ui/*.mjs` 与选定 `src/*.mjs`，并提供仅用于构建的 `node:crypto#createHash` 浏览器 shim（`ui/hash.mjs`）；真实浏览器旅程未执行。
