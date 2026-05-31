# Go Gateway 架构

## 职责边界

Gateway 是远程访问中继，不是 Agent 执行环境。它同时面对桌面 Agent 和浏览器 WebUI：

| 方向 | 协议 | 作用 |
|---|---|---|
| Desktop Agent -> Gateway | gRPC `AgentGateway.AgentConnect` 双向流 | 桌面端注册在线 session，接收 WebUI 请求，返回 chat/history/settings/memory/skills 等响应与事件。 |
| WebUI -> Gateway | WebSocket `/ws` | 浏览器端发起 chat、history、settings、skills、memory、cron 等 request，并订阅实时事件。 |
| WebUI -> Gateway | HTTP `/api/*` | 状态检查、文件上传、公网分享页、图片代理、静态资源。 |

## 入口与服务启动

| 文件 | 作用 |
|---|---|
| `cmd/gateway/main.go` | 读取 config，创建 `session.Manager`，启动 gRPC server 与 HTTP server，处理 shutdown。 |
| `cmd/gateway/shutdown.go` | gRPC graceful stop 超时后强制 stop。 |
| `internal/config/config.go` | 地址、token、TLS、静态资源、请求大小、超时等配置。 |
| `internal/auth/grpc_interceptor.go` | gRPC token 校验。 |
| `internal/auth/http_middleware.go` | HTTP API token 校验。 |
| `internal/server/grpc.go` | `AgentGateway` gRPC 服务实现。 |
| `internal/server/http.go` | HTTP mux、WebSocket、API、静态 WebUI 与 public share route。 |
| `internal/server/websocket.go` | WebUI WebSocket 连接生命周期、鉴权、订阅 forwarder。 |
| `internal/server/websocket_routes.go` | WebSocket request type 到 domain handler 的路由表。 |
| `internal/server/websocket_*_handlers.go` | fs/history/settings/chat/terminal/git/skills/memory/cron/provider 等 domain handler。 |
| `internal/server/websocket_payloads.go` | WebSocket 响应 payload 组装与 JSON helper。 |
| `internal/server/websocket_roundtrip.go` | payload 严格解码、Agent unary round-trip 和错误文案归一。 |
| `internal/server/websocket_writer.go` | WebSocket 并发写锁、write deadline 与 envelope 发送。 |
| `internal/server/websocket_connection_state.go` | 单条 WebSocket 连接内的 chat active/attach 和 terminal interest 状态。 |
| `internal/session/manager.go` | `session.Manager` façade 和核心公开类型。 |
| `internal/session/manager_state.go` | session registry、sync hub、chat run store 的内部状态定义。 |
| `internal/session/manager_registry.go` | 当前 Agent session、认证快照、per-request stream 注册。 |
| `internal/session/manager_*_sync.go`、`manager_terminal.go`、`manager_chat_runs.go` | history/settings/terminal sync 与 chat run buffer/replay/dedupe。 |

## HTTP 路由

| 路由 | 认证 | 说明 |
|---|---|---|
| `GET /ws` | token | WebUI 主 WebSocket 协议。 |
| `GET /api/status` | token | Gateway 当前 Agent 在线状态。 |
| `POST /api/files/import` | token | WebUI 上传可读文件，Gateway 转发给桌面端导入 workspace uploads。 |
| `GET /api/public/history-shares/{token}` | public token | 公开只读历史分享数据。 |
| `GET /image-proxy` | 视配置/实现而定 | 图片代理，带 URL 安全校验。 |
| `/` | 无或按静态资源策略 | 嵌入/构建后的 WebUI 静态资源与 SPA fallback。 |

## gRPC 服务

| RPC | 类型 | 用途 |
|---|---|---|
| `Authenticate(AuthRequest) -> AuthResponse` | unary | 桌面端认证探活，返回 session 信息。 |
| `AgentConnect(stream AgentEnvelope) -> stream GatewayEnvelope` | bidirectional stream | 桌面端常驻连接，WebUI request 下发为 `GatewayEnvelope`，桌面端 response/event 回传为 `AgentEnvelope`。 |

`proto/v1/gateway.proto` 是 Desktop 与 Gateway 的权威协议定义；Go 侧生成文件位于 `internal/proto/v1/*`。

## Session Manager

`session.Manager` 是 Gateway 状态 façade，对外维持原有 API；内部按职责拆成 session registry、sync hub 和 chat run store，避免一个锁覆盖所有状态。

| 状态 | 说明 |
|---|---|
| session registry | 当前桌面 Agent session、认证快照、session epoch、per-request stream。 |
| sync hub | history/settings/terminal 订阅者、settings 快照、terminal session snapshot。 |
| chat run store | chat broadcast subscriber、requestId/conversationId/clientRequestId 索引、event buffer、seq、retention。 |

## Chat Run 缓冲与恢复

| 机制 | 当前含义 |
|---|---|
| `maxBufferedChatRunEvents` | 单个 chat run 最多缓存 50000 个事件，避免无界内存增长。 |
| `chatRunDoneRetention` | 已完成 run 保留 1 小时，用于刷新/断线后恢复最终事件。 |
| `chatRunStaleRetention` | 未完成但长时间无更新的 run 保留 12 小时后清理。 |
| `chatRunByConversation` | conversationId 到 requestId 的索引，用于 attach 当前运行会话。 |
| `chatRunByClientRequest` | clientRequestId 去重，避免 WebUI 重复 chat.start 创建重复运行。 |
| `Seq` | WebUI 可用 `afterSeq` 补收漏掉的事件。 |

## WebSocket 协议角色

| 类型 | 说明 |
|---|---|
| request/response | WebUI 发带 id 的 request，Gateway 返回同 id response 或 error。 |
| broadcast | Gateway 主动推送 `status`、`history.event`、`settings.event`、`conversation.event` 等。 |
| chat stream | `chat.start` 创建 run，`chat.attach`/`chat.resume` 接入已有 run，`chat.cancel` 取消运行。 |

WebSocket server 的实现按三层组织：`websocket.go` 管连接生命周期和订阅 forwarder；`websocket_routes.go` 管 request 路由；`websocket_*_handlers.go` 管 domain handler。handler 只做 payload 校验、调用 Gateway/Desktop service、组装 WebUI 响应。连接内的可变状态不再直接铺在 `websocketConnection` 上，而是通过 chat/terminal tracker 管理。

Terminal event 的转发规则保持与 WebUI SharedWorker 一致：metadata 类事件用于同步 session/project 状态，可广播到已认证连接；`output` 事件必须先通过 `terminal.attach` 记录 session interest 后才转发，`terminal.detach` 会移除该 session interest。

## 安全模型

| 领域 | 设计 |
|---|---|
| 认证 | HTTP API 与 WebSocket 通过 token；gRPC 通过 interceptor 校验 token。 |
| Provider API key | 普通 settings sync 不应携带真实 key；WebUI 只接收 presence/redacted 字段。 |
| 文件访问 | WebUI 上传只把 bytes 交给桌面端导入，Gateway 不直接落地为任意本地路径。 |
| 工具执行 | Gateway 不运行 Shell、FS、MCP、Memory mutation 等高权限工具，只转发请求到桌面端。 |
| Public share | 分享数据走 token 定位，支持只读 transcript，并可按设置 redaction tool content。 |
| Public share error | 桌面端通过 `ErrorResponse.code` 返回 `history_share_resolve` 错误语义，Gateway HTTP 根据 code 映射 400/404/502 等状态，不再依赖错误文案判断。 |

## Gateway 失败模式

| 失败 | 表现 | 设计处理 |
|---|---|---|
| Desktop offline | WebUI 请求返回 agent offline 或状态 offline | `session.Manager` 检测当前 session，WebUI 展示离线/不可用状态。 |
| WebSocket 断开 | WebUI 自动重连，chat run 可 attach/resume | `GatewayWebSocketClient` 与 SharedWorker 管理重连，Gateway 缓冲 seq event。 |
| gRPC stream 断开 | Agent session close，pending stream 结束 | 桌面端 remote auto reconnect 可重新建立 session。 |
| Chat run 重复提交 | 同一 clientRequestId 重复 | `chatRunByClientRequest` 去重。 |
| 服务退出 | Ctrl+C 后 HTTP/gRPC shutdown | `cmd/gateway/main.go` 和 `shutdown.go` 控制 graceful/force stop。 |
