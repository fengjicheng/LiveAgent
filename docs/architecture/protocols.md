# 协议与同步合同

## 协议总览

| 通道 | 端点 | 方向 | 用途 |
|---|---|---|---|
| gRPC unary | `AgentGateway.Authenticate` | Desktop -> Gateway | 桌面端认证与 session 初始化。 |
| gRPC stream | `AgentGateway.AgentConnect` | Desktop <-> Gateway | 桌面端常驻双向通道，承载 GatewayEnvelope 与 AgentEnvelope。 |
| WebSocket | `GET /ws` | WebUI <-> Gateway | WebUI 主交互协议，请求/响应、状态广播、chat stream。 |
| HTTP API | `/api/status` | WebUI -> Gateway | 查询 Agent 在线状态。 |
| HTTP upload | `/api/files/import` | WebUI -> Gateway -> Desktop | 上传可读文件并导入桌面 workspace。 |
| Public HTTP | `/api/public/history-shares/{token}` | Browser -> Gateway | 公开只读历史分享。 |

## gRPC Envelope

`crates/agent-gateway/proto/v1/gateway.proto` 定义两个主 envelope：

| Envelope | 方向 | payload 示例 |
|---|---|---|
| `GatewayEnvelope` | Gateway -> Desktop | `ChatRequest`、`CancelChatRequest`、`CronManageRequest`、`History*Request`、`ProviderListRequest`、`Settings*Request`、`Skill*Request`、`FileMentionListRequest`、`UploadReadableFilesRequest`、`MemoryManageRequest`。 |
| `AgentEnvelope` | Desktop -> Gateway | `ChatEvent`、`CronManageResponse`、`History*Response`、`HistorySyncEvent`、`ProviderListResponse`、`Settings*Response`、`SettingsSyncEvent`、`Skill*Response`、`UploadReadableFilesResponse`、`MemoryManageResponse`、`ErrorResponse`。 |

## Chat 协议

| 阶段 | WebUI -> Gateway | Gateway -> Desktop | Desktop -> Gateway -> WebUI |
|---|---|---|---|
| 开始 | `chat.start` | `ChatRequest` | `ChatEvent` stream |
| 续接 | `chat.resume` 或 `chat.attach` | 通常不重新下发执行，只订阅已有 run | 从 `afterSeq` 开始补发 buffer event |
| 取消 | `chat.cancel` | `CancelChatRequest` | `ERROR` 或 `DONE` 等终态事件 |
| 完成 | 无 | 无 | `ChatEvent.type=DONE` |

`ChatEvent` 类型包括 `TOKEN`、`THINKING`、`TOOL_CALL`、`TOOL_RESULT`、`DONE`、`ERROR`、`TOOL_STATUS`、`HOSTED_SEARCH`。Gateway 为每个事件附加递增 seq，WebUI 通过 seq 保证断线后可恢复。

## Settings 同步

| 操作 | 方向 | 语义 |
|---|---|---|
| `settings.get` | WebUI -> Gateway -> Desktop | 读取桌面端当前 settings snapshot。 |
| `settings.update` | WebUI -> Gateway -> Desktop | 更新设置；provider secret 使用单独 `providerApiKeyUpdates`。 |
| `settings.event` / `SettingsSyncEvent` | Desktop -> Gateway -> WebUI | GUI 本地保存后广播脱敏 settings snapshot。 |

设置协议的关键约束是 provider API key 不走普通 sync snapshot。WebUI 只能看到 redacted provider 数据和 `apiKeyConfigured` 状态。

## History 同步

| 操作 | 语义 |
|---|---|
| `history.list` | 分页读取 conversation summary，用于 sidebar。 |
| `history.get` | 读取 conversation detail；支持 `max_messages` 返回 tail window。 |
| `history.rename` | 修改标题并广播 upsert event。 |
| `history.pin` | 修改置顶状态并保持排序。 |
| `history.share.get/set` | 管理公开分享 token 与 redaction 选项。 |
| `history.delete` | 删除会话和相关 FTS/share 行。 |
| `history.truncate` | 编辑重发等场景截断历史。 |

桌面端是历史数据库真相源；Gateway 负责 request forwarding 和 sync event broadcasting；WebUI 负责本地列表和 transcript 状态更新。

## Upload 协议

| 步骤 | 说明 |
|---|---|
| 1 | WebUI 将文件通过 multipart POST 到 `/api/files/import`。 |
| 2 | Gateway 读取文件 bytes，注册 request stream，转成 `UploadReadableFilesRequest` 发给 Desktop。 |
| 3 | Desktop 根据 workdir 导入 `.liveagent`/uploads 类工作区位置，返回 `ChatUploadedFile` 列表和 skipped 列表。 |
| 4 | WebUI 把返回的 uploaded files 附加到下一次 `chat.start`。 |

GUI 本地上传不需要 HTTP/Gateway，直接通过 Tauri command 导入。

## Public Share 错误码

`/api/public/history-shares/{token}` 仍然通过 Gateway 转发到桌面端解析 share token。桌面端返回 `ErrorResponse.code` 后，Gateway HTTP 直接按 code 映射状态：

| code | HTTP | 场景 |
|---:|---:|---|
| `400` | Bad Request | share token 为空或请求非法。 |
| `404` | Not Found | 分享链接不存在、已关闭，或对应历史对话不存在。 |
| 其他 | Bad Gateway | 桌面端处理失败或返回未知错误。 |

Gateway 不再通过错误文案推断 public share 状态，错误语义由桌面端产生并通过 proto 传递。

## Terminal Event 兴趣模型

WebUI 的 terminal 事件以 session/project interest 控制：

| 事件 | 转发规则 |
|---|---|
| metadata，例如 `created`、`exit`、`closed` | 可广播给已认证连接，用于保持 session/project 列表新鲜。 |
| `output` | 必须先通过 `terminal.attach` 订阅具体 `session_id`；`terminal.detach` 后停止转发。 |

Gateway 的连接态 tracker 只维护 WebSocket 连接内的短期 interest，不改变桌面端 terminal registry，也不改变现有 wire payload。

## Skills 与 Memory 管理协议

| 能力 | WebUI 方法 | Desktop 落点 |
|---|---|---|
| Skills 列表和管理 | `skills.list`、`skills.manage`、`skills.read-metadata`、`skills.read-text` | `system_ensure_builtin_skills`、`system_manage_skill`、`system_read_skill_*`、`services/skills.rs` |
| Memory 管理 | `memory.manage` | `commands/memory.rs`、`services/memory.rs` |
| Cron 管理 | `cron.manage` | `commands/cron.rs`、`services/cron.rs`、settings cron 表 |

## 恢复与去重机制

| 机制 | 位置 | 目的 |
|---|---|---|
| `clientRequestId` | WebUI chat.start -> Gateway session manager | 避免重复提交导致两个真实 chat run。 |
| `conversationId` -> run index | Gateway session manager | 当前会话刷新/切换后可 attach 正在运行的 stream。 |
| `Seq` | Gateway chat buffer | 断线后从 `afterSeq` 补发缺失事件。 |
| done retention | Gateway session manager | 已结束 run 短时间保留，支持刷新后看到终态。 |
| local running ids | WebUI App | 避免正在运行会话被错误切换或误删。 |

## 协议改造注意点

| 场景 | 必查点 |
|---|---|
| 新增 Gateway request | 同步 `proto/v1/gateway.proto`、Go server、Tauri gateway bridge、WebUI client method。 |
| 新增 settings 字段 | GUI settings normalize/storage、Rust settings save/load、Gateway redaction whitelist、WebUI settings copy 都要同步。 |
| 新增 history 字段 | Rust summary model、proto `ConversationSummary`、Gateway websocket payload、GUI/WebUI sidebar render 都要同步。 |
| 新增 chat event | Desktop event publisher、proto enum、Gateway WS encoder、WebUI event reducer/transcript 都要同步。 |
| 涉及 secret | 默认不进普通 sync，必须设计单向或显式更新通道。 |
