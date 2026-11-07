# 06 / 07 / 08 软件设计独立评审

日期：2026-11-07。评审角色：`/root/review_surfaces`，未参与这三份设计编写。本轮仅阅读文档、已保存Host源码及本机ASAR指定条目；没有实现、导入或运行插件，没有安装、读凭据、调用模型或执行真实会话操作。结论只针对设计，不认证运行兼容/出口。

## 初审基线与历史结论

| 文档 | 本次审查SHA256 |
|---|---|
| [07上下文设计](../07-context-management/docs/software-design.md) | `4b68cb8c87948f5f7eee54c8ca1f6883c74750f91897d1b2ebf1b97e53f71da8` |
| [08工作台设计](../08-workbench-ui/docs/software-design.md) | `d2261cdd04fcb5fa60cd3986481ee89921190e6614f324b2090e9a295289e274` |
| [06图示设计](../06-local-diagrams/docs/software-design.md) | `c079cebfb6be70e678078320f9be84bcf70fc9c9cfaf186f83ed7fe35d31651e` |

**初审发现三个Important设计缺口，未发现Critical项；均已在下方复核关闭。** 以下保留原发现及初审摘要，当前结论和绑定SHA以文末复核为准。三份文档的产品形态均符合已确认方向，问题不需要再向用户询问内部机制。

符合项：07首版只读、阶段/估算/usage分开，后置维护需运行租约；08保留Harness所有权和分阶段接入，拒绝不兼容全家桶；06首版含生成及本地可视化编辑，自有受限编辑器避免被未审Drawio包阻塞。三者均区分调查身份与交付source-lock，定义稳定需求/接口/验收ID、并发与unknown恢复、范围与无额外出口门禁；没有搬用05测试冒称本模块通过。

## Important发现与具体修订

### SR-01：核心UI→Host传输和身份映射没有落到可编码合同

位置：07 §4–5（原L128、135、153、240）；08 §5/8（原L132、165、201）；06 §9（原L213）。

三份文档定义了内部函数及可信`caller`，但核心界面边界仅写“原鉴权RPC”“Host可信绑定”。没有冻结实际注册/调用方法、端点名、序列化结果/错误、`subscribe(listener)`怎样跨进程，以及登录Peer如何映射本地scope权限。开发者仍需自行设计整个关键边界，且容易把登录成功误作任何项目的读写许可。

本次从实际`E:/dsh/resources/app.asar`只读核到可用接缝（归档SHA256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915`）：

| 归档内文件（前缀`dsh/node_modules/@deepseek-ai/`） | SHA256 | 源码事实 |
|---|---|---|
| `dsh-client-connection/lib/index.js` | `0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684` | L724–728：`ctx.connection.rpc.handle(channel,handler)`；L855–871：fiber管理注册且调用`admit`；L888–913：`handler(endpoint,payload,request.signal,peer)`；默认捕获异常会把`String(error)`写入500正文 |
| `dsh-client-connection/lib/client.browser.js` | `dfc3544eb894c74b340a4c4c63a8c125fd2e983df9efed5885712574af994e62` | L1212：`rpc.call(channel,endpoint,payload,signal)`；L1443：handle提供rpc |

`admit`（Host L742–749）做Host/Origin、浏览器会话/API身份检查，浏览器共用`principal.kind='owner'`的Peer（L714）。这些不是自动提供的项目grant。

建议固定三个独立channel及endpoint表，如`/local-context`、`/local-workbench`、`/local-diagrams`；严格请求/返回schema、只接收受控引用，端点闭包从真实Peer取身份，拒绝payload caller/grant。明确owner-only首版、本地项目/文档registry授权、generation撤销重核与调用所属模块再授权。内部listener留在Host；前端订阅先采用带`after_revision`的有界轮询或另锁已核的stream接口，不把函数跨JSON传送。所有endpoint先捕获并转成不含原始路径/配置/堆栈的固定错误；不得依赖Host默认500过滤。清理时卸载channel并取消轮询。

最小验收：实际安装库的认证Peer和合成项目registry穿过同一channel；伪造身份、跨scope、撤权、未知endpoint、旧generation、超限body、重复请求及故意带秘密的异常均拒绝或脱敏；切会话和卸载无迟到更新。仍需完整Host/UI和OS出口验收，源码接口核实不能替代它们。

### SR-02：08的Host descriptor.open没有定义跨到client导航的执行方式

位置：08 §4–5/8（原L118–139、151–165、201）。

同一个`ModuleDescriptorV1`混合Host侧`getStatus/quiesce/dispose`与`open`。现有架构图为client→08 Host registry/actions→模块descriptor，而真正`ctx.layout.selectPanel`是client API。`ActionResultV1`没有导航目标或client确认，无法从合同确定Host如何打开client面板、何时可返回`opened`；容易形成另造私有API或服务端提前宣告打开成功。

建议拆清Host descriptor和ClientNavigationAdapter。Host只返回带scope/generation/revision的白名单`NavigationIntentV1`（panel key、登记skill引用、登记host_command引用），client校验当前epoch后调用真实本地layout；`opened`只在client成功选择目标后展示。skill/command没有核到调用接口时，给确定的可见指令/复制入口或明确blocked，不执行任意shell，也不把accepted显示为任务完成。将动作幂等/旧epoch/目标面板不存在的结果写入合同。

最小验收：Host只产数据不能执行client函数；panel正常打开/返回聊天；旧scope intent、未知key、乱序响应被丢弃；目标未注册显示unavailable；Host accepted和client opened分开记录。

### SR-03：06首版概念图新增节点的overlay和命令schema相互矛盾

位置：06 §4（原L122）、§7（原L166）。

`AnnotationOverlayV1.items`仅有`kind:'note'|'edge'|'layout'`及note/edge/position字段；首版后文又允许`add_annotation_node {id,label,x,y}`。它没有明确可持久化的node条目、尺寸/节点属性、删除节点命令，且“kind冻结”枚举先不含该命令再追加。严格`additionalProperties:false`下，新增节点无法按当前overlay合法保存并重开；各实现会自行猜schema。

建议把overlay改成明确discriminated union（至少note、annotation_node、annotation_edge、layout），给每种必填字段、ID碰撞/端点/删除关联边规则。统一完整命令枚举和payload，节点删除生成可恢复的复合逆命令；base证据实体仍不能删除或被手工改为exact。明确XML导入→base/overlay→编辑→XML/JSON保存→重开怎样保留annotation节点，不信任外部XML元数据提升证据。

最小验收：空conceptual图新增两节点及一边→移动/注释→保存重开→删除一节点并undo/redo；源base摘要不变，annotation保持unknown，关联边和孤儿注释恢复规则稳定，严schema不会丢新节点。

## 本次核对证据与限制

已实读07/08/06全文、共同合同与软件设计合同；重算三文档和本机归档摘要；从归档只读解析layout/renderer/connection指定JS。核对到layout/renderer摘要与设计一致：`eb011a7b5699fac7f3ad0aa15408f46a6cf47f79b8cc15db1f81739e81e70587`、`dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356`；实际`selectPanel`要求目标已注册，说明导航失败分支必需。还读保存的Session/LLM/AgentLoop源码，确认deriveMessages、surface generation、llm waterfall的描述具备源码依据。

没有运行上述设计的未来命令；这些脚本/模块尚待创建。来源表中的远端固定树未重新联网拉取，不能据此认证上游完整许可/依赖闭包。没有检查完整ASAR每个模块或全Host遥测出口，未给出无外发认证。

## DESIGN-2 独立复核关闭记录

复核日期：2026-11-07。三份设计由其他角色修订，`review_surfaces`只读复核并更新本报告，没有参与其修订。复核当前文档、各自product-form/README及实际ASAR Connection RPC类型/序列化路径；没有运行未来功能测试或用例。

| 文档现行版本 | 复核绑定SHA256 |
|---|---|
| 07 CTX-DESIGN-2 | `bdbbec5e4a76d4b19fa2d6d984d1446bd8096abb3070157ff53e0023394c16ba` |
| 08 UI-DESIGN-2 | `4d6704a4e3991c23e05c4982c91e08a56718290ac0fabc6f545ea3a2a2a111e9` |
| 06 DIA-DESIGN-2 | `391846299bf24d8acdca454b19e80cdd2eb3d8af65e940caeb0a1d6bfa114d5d` |

| 原发现 | 修订及复核证据 | 结论 |
|---|---|---|
| SR-01 | 三文档新增CTX-RPC-01/UI-RPC-01/DIA-RPC-01：固定真实handle/call方法、独立channel、endpoint input/data表、owner身份与本地scope/文档/profile registry许可分离、generation撤销、分页/大小、错误脱敏；内部listener不跨JSON，07/08采用明确有界轮询，06操作查状态。追加真实`RpcResult`外层与client显式unwrap路径，见下段 | 关闭（设计） |
| SR-02 | 08 §5–6新增Host `descriptor.planOpen`与client `ClientNavigationAdapter`、`NavigationIntentV1`；panel白名单及当前scope/revision/epoch/expiry校验，client实际selectPanel后才opened；skill/host_command首版只展示登记指令卡，receipt仅诊断。UI-04映射与README默认自有main UI也已同步 | 关闭（设计） |
| SR-03 | 06 §4/7新增具体OverlayItem discriminated union，包含annotation_node/edge、note/layout/visibility；完整命令枚举和payload、节点删除关联项、复合inverse/undo/redo；本地canonical base/overlay/XML同revision往返，外部XML降为conceptual且不信任exact元数据。严格XML属性白名单补visible，自身隐藏cell可解析；新增两节点一边保存重开/删节点/undo负例 | 关闭（设计） |

第二次走读发现SR-01的原修订还把业务`status/data`当成整个RPC结果。实际ASAR源码的`rpcResultSchema`（Host L621–642）、`fullResponse`（L938起）和client `call`（L1228–1231）要求handler返回`{ok:true,value:BusinessResponse}`，client返回RpcResult而不自动unwrap。协调者已在三文档补“RpcResult传输合同（SR-01补正）”：业务拒绝/内部固定失败仍放value；客户端先检查ok再校验value及epoch；连接层ok:false映射固定TRANSPORT_FAILURE，不展示原错误或重发写操作；type/rpcId由Connection负责。该修订与实读源码一致。未来真实handle→call正常/拒绝/传输失败/金丝雀测试已写入门禁，本轮没有声称执行。

本次还对9个文件（3份设计、3份产品说明、3份README）检查本地Markdown链接及围栏：未发现缺失链接或未闭合围栏；这只证明文档结构，不证明业务行为。产品说明仍符合已有确认：07只读先行、08 Harness内统一工作台、06生成及可视化编辑首版均必需。设计默认未冒写为用户逐机制确认。

**当前结论：SR-01—03均关闭，无未关闭Critical/Important设计发现；三份可作为编码交接依据。** 真实client打包/Loader、完整Host身份通道、OS级出口、06编辑/保存旅程、08 profile恢复与真实05/07接入，以及07后置写入所需运行租约仍是未执行门禁。设计通过不表示插件可安装或运行安全已认证。后续变更若改动这些合同，须按需求映射局部重新评审，不沿用本摘要认证新字节。

**接下来该怎么做：** 协调者用约10分钟将当前摘要与关闭状态纳入总设计交接清单；完成标准是三份设计入口、产品范围和复核记录相互对应，运行门禁仍明确未执行。
