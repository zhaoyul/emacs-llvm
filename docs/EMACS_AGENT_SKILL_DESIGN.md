# Emacs Agent Skill 完整设计与实施规格

- 项目名称: Emacs Operator
- Skill 名称: `emacs-native-operator`
- 仓库建议名称: `emacs-operator`
- 文档版本: 1.0
- 文档日期: 2026-08-29
- 状态: Implementation Ready
- 首发平台: macOS
- 后续平台: Windows, Linux
- 目标读者: LLM Coding Agent, 软件架构师, Emacs Lisp 开发者, macOS 原生开发者

## 0. 文档使用方式

本文件是本项目的主规格. 编码 Agent 必须先完整读取本文件, 再读取同目录下的 `AGENTS.md`, `SKILL.md`, `schemas/`, `examples/` 和 `prompts/implementation-master-prompt.md`.

本规格中的 `MUST`, `SHOULD`, `MAY` 分别表示必须实现, 建议实现, 可选实现. 编码 Agent 不得在没有记录 ADR 的情况下改变标注为 `MUST` 的架构决策.

推荐执行方式:

1. 在一个新的 Git 仓库根目录解压本设计包.
2. 将 `prompts/implementation-master-prompt.md` 作为第一次任务交给编码 Agent.
3. 要求 Agent 按第 22 章的阶段顺序开发.
4. 每个阶段结束后, Agent 必须运行对应测试, 更新 `STATUS.md`, 然后才能进入下一阶段.
5. 第一版只交付 macOS, 但所有核心接口必须保持跨平台抽象.

## 1. 项目摘要

Emacs Operator 是一个面向 LLM Agent 的本地 Emacs 操作运行时. 它让大模型不仅能直接修改文件, 还能够以 Emacs 原生方式调用 major mode, minor mode, keymap, interactive command, minibuffer, REPL 和第三方扩展.

系统提供 3 条执行通道:

1. `semantic`: 通过 Emacs Lisp RPC 读取状态和直接调用命令. 这是默认通道, 支持后台 Emacs, 可靠性最高.
2. `internal_keys`: 在 Emacs 内部执行按键事件序列. 事件经过当前 keymap 和 command loop 语义, 可以触发 paredit, org-mode, magit, SLY, CIDER 等交互命令. 该通道不要求 Emacs 位于桌面最前方.
3. `native_keys`: 通过操作系统原生输入 API 注入真实键盘事件. macOS 使用 CGEvent, 该通道要求 Emacs 获得桌面焦点, 并且需要系统 Accessibility 权限.

系统不是单纯的键盘机器人. 它必须形成完整闭环:

```text
Observe -> Plan -> Checkpoint -> Act -> Verify -> Commit or Rollback
```

核心价值是把 Emacs 作为 Agent Runtime, 而不是把 Emacs 当成一个被盲目敲键的文本框.

## 2. 背景与问题定义

普通 coding agent 通常直接读写文件. 这种方式不能自动继承 Emacs 中已经存在的交互语义, 例如:

- paredit 的结构化 S-expression 操作.
- org-mode 的标题层级, subtree, property drawer, TODO, timestamp, table, Babel 和导出行为.
- SLY, SLIME, CIDER 中与当前 REPL, namespace, package, connection 相关的运行时状态.
- Magit, transient, completion, minibuffer 和第三方 mode 的状态机.
- 用户自定义 keymap, advice, hook, minor mode 和命令组合.

直接文本替换可以生成正确结果, 但它绕过了用户工具链. Emacs Operator 的任务是让 Agent 能够选择最合适的操作层级:

```text
文本层 -> 语法结构层 -> Emacs 命令层 -> Emacs 按键层 -> 桌面物理输入层
```

## 3. 产品目标

### 3.1 必须达到的目标

1. LLM 可以发现一个或多个正在运行的 Emacs 实例.
2. LLM 可以建立显式 session, 锁定目标 Emacs, frame, window, buffer 和 project.
3. LLM 可以读取当前 buffer, major mode, minor modes, point, mark, region, minibuffer, window 和局部上下文.
4. LLM 可以执行任意可表示的 Emacs 按键序列, 而不是依赖硬编码快捷键表.
5. `internal_keys` 必须经过当前 active keymaps, 能触发 paredit 和 org-mode 的实际命令.
6. `native_keys` 必须在 macOS 上通过 CGEvent 发送 key down 和 key up, 并在发送前验证 Emacs 确实是 frontmost application.
7. LLM 可以调用 interactive command, 查询 key binding, 查询 command 文档和可用能力.
8. 所有修改必须支持 checkpoint, 验证和可恢复机制.
9. 系统必须检测状态冲突, 用户并发输入和焦点漂移.
10. 第一版必须通过 MCP stdio 暴露给 LLM Host, 同时保留未来打包为 MCP Bundle 的结构.
11. 核心协议, session, policy, bridge 和 mode adapter 必须与操作系统无关.
12. macOS 原生能力必须被隔离在独立 driver 中, 后续替换 Windows 和 Linux driver 时不修改上层工具契约.

### 3.2 质量目标

- `observe` 的 compact 响应默认不传整个 buffer.
- 任何 mutating tool 都必须返回前后状态摘要.
- 任何错误都必须包含稳定错误码, 人类可读消息和可恢复建议.
- 工具调用必须可审计.
- 无权限时必须明确失败, 不得静默降级为不安全方案.
- 不得让多个 Agent 同时修改同一个 Emacs target.

## 4. 非目标

第一版不承担以下目标:

1. 不构建通用远程桌面控制产品.
2. 不承诺支持所有硬件专用键, Touch Bar, 游戏键盘宏键和厂商自定义 HID 事件.
3. 不试图绕过 macOS TCC, Accessibility 或 Screen Recording 权限.
4. 不在第一版支持多人共享远程 MCP 服务.
5. 不保证所有第三方 Emacs package 都能在完全无 UI 的 daemon frame 中运行.
6. 不把 OCR 作为主要状态读取方式. Emacs 内部状态优先, 截图只用于视觉验证.
7. 不允许默认执行任意 Emacs Lisp, shell command 或外部进程.

## 5. 核心架构决策

### ADR-001: 使用 Agent Skill + MCP Server 双层交付

`SKILL.md` 负责告诉 Agent 何时和如何使用 Emacs Operator. MCP Server 负责提供真实工具能力. Skill 本身不能代替工具执行层.

MCP 本地部署首先使用 stdio. 当前 MCP 规范不依赖隐式协议 session, 因此本系统所有跨调用状态都必须使用服务器生成的显式 `session_id`.

### ADR-002: 三通道执行模型

| 通道 | 是否需要 Emacs 前台 | 是否经过 Emacs keymap | 是否是真实 OS 输入 | 默认用途 |
|---|---:|---:|---:|---|
| `semantic` | 否 | 可选 | 否 | 查询状态, 精确编辑, 调用命令 |
| `internal_keys` | 否 | 是 | 否 | paredit, org-mode, minibuffer, package 操作 |
| `native_keys` | 是 | 是, 由 Emacs 接收后解析 | 是 | 桌面级验证, 真实键盘行为, UI 自动化 |

Agent 必须默认优先 `semantic`, 需要验证 keymap 或交互状态时使用 `internal_keys`, 只有任务明确需要真实桌面输入时才使用 `native_keys`.

### ADR-003: Emacs Bridge 使用持久本地连接

不得把 `emacsclient --eval` 作为主要协议. 它可以作为安装和诊断 fallback, 但持续运行时必须使用 Emacs 内部 bridge 提供的持久本地 IPC.

MVP 采用:

- Loopback TCP.
- JSON-RPC 2.0 message semantics.
- `Content-Length` framing.
- 随机端口.
- 每个 Emacs instance 独立随机 token.
- runtime directory 权限限制为当前用户.

选择 TCP 而不是只使用 Unix Domain Socket, 是为了后续 Windows 复用相同协议和测试工具.

### ADR-004: macOS 原生输入由稳定 App Bundle 持有权限

产品形态使用签名的 `EmacsOperatorHost.app`, 而不是每次重新编译的临时脚本. Host app 持有 Accessibility 和 Screen Recording 权限, 并通过本地 IPC 为 MCP Server 提供 native input, focus 和 capture 能力.

开发期可以提供 CLI helper, 但 CLI helper 不得成为最终发布形态.

### ADR-005: 不硬编码快捷键

系统提供通用事件模型, 并让 Emacs 自己解析 keymap. Mode pack 可以提供推荐命令, 但每次执行前都应通过 `key-binding`, `where-is-internal` 或 command registry 验证当前环境.

### ADR-006: 所有写操作采用显式前置条件

每次修改都可以附带:

- `expected_state_seq`.
- `expected_buffer_tick`.
- `expected_buffer_id`.
- `expected_major_mode`.
- `expected_frontmost_pid`, 仅 native 模式.

不满足时返回冲突, 不得继续盲写.

## 6. 总体架构

```text
+---------------------------------------------------------------+
|                       LLM / Coding Agent                      |
+-------------------------------+-------------------------------+
                                |
                                | Agent Skill instructions
                                v
+---------------------------------------------------------------+
|                     MCP Host / Agent Host                     |
+-------------------------------+-------------------------------+
                                |
                                | MCP stdio
                                v
+---------------------------------------------------------------+
|                 emacs-operator-mcp-server                     |
|                                                               |
|  Tool Router  Session Manager  Policy Engine  Audit Log       |
|  Capability Registry  Transaction Manager  Driver Router      |
+------------------+-----------------------------+--------------+
                   |                             |
                   | Bridge RPC                  | Driver RPC
                   v                             v
+--------------------------------+   +---------------------------+
| emacs-operator-bridge.el       |   | EmacsOperatorHost.app     |
|                                |   |                           |
| Observe state                  |   | Accessibility permission  |
| Execute internal key events    |   | Focus and AX window ops   |
| Call interactive commands      |   | CGEvent key injection     |
| Buffer transactions            |   | ScreenCaptureKit          |
| Org and Lisp adapters          |   | User-input interference   |
+----------------+---------------+   +-------------+-------------+
                 |                                 |
                 v                                 v
+---------------------------------------------------------------+
|                         GNU Emacs                             |
| Buffer  Window  Frame  Keymaps  Minibuffer  REPL  Packages   |
+---------------------------------------------------------------+
```

## 7. 部署拓扑

### 7.1 MVP 本地拓扑

```text
MCP Host
  -> launches emacs-operator-mcp-server by stdio
      -> discovers Emacs bridge instances
      -> connects to selected bridge over 127.0.0.1
      -> optionally connects to EmacsOperatorHost.app over local socket
```

### 7.2 Emacs 实例发现

Bridge 启动后写入 instance record:

```json
{
  "protocol_version": "1.0",
  "instance_id": "emacs-7b9629b4",
  "pid": 4128,
  "host": "127.0.0.1",
  "port": 49321,
  "token_file": "/private/.../token",
  "emacs_version": "31.x",
  "system_type": "darwin",
  "window_system": "ns",
  "started_at": "2026-08-29T09:00:00Z",
  "heartbeat_at": "2026-08-29T09:00:05Z"
}
```

Runtime directory 选择顺序:

1. 显式环境变量 `EMACS_OPERATOR_RUNTIME_DIR`.
2. macOS 的用户级临时目录.
3. Linux 的 `XDG_RUNTIME_DIR`.
4. Windows 的用户级 LocalAppData runtime 子目录.

目录和 token 文件必须仅当前用户可读写.

## 8. 推荐技术栈

### 8.1 MCP Server

- TypeScript.
- Node.js 当前 Active LTS, 版本必须锁定.
- 官方 MCP SDK.
- `zod` 或 JSON Schema 进行参数校验.
- `vitest` 进行单元测试.
- `pnpm` 管理 monorepo.

选择 TypeScript 的原因:

- MCP 工具 schema 和结构化结果易于维护.
- 跨平台进程和 socket 支持成熟.
- LLM Coding Agent 对 TypeScript 代码生成和测试修复能力稳定.
- 原生 driver 可以通过独立进程隔离, 不要求核心层使用同一种语言.

### 8.2 Emacs Bridge

- Emacs Lisp.
- 最低支持 GNU Emacs 29.
- 使用 `json-parse-string`, `json-serialize`, network process, hooks, markers, change groups 和 keyboard macro APIs.
- 使用 ERT 测试.

### 8.3 macOS Driver

- Swift.
- SwiftUI 或 AppKit 构建轻量 Host app.
- ApplicationServices Accessibility API.
- CoreGraphics CGEvent.
- ScreenCaptureKit.
- XCTest.
- 稳定 bundle identifier 和签名配置.

### 8.4 后续平台

- Windows driver: C# 或 Rust, 推荐 C# 当前 LTS .NET, 使用 SendInput, UI Automation 和 Windows Graphics Capture.
- Linux driver: Rust, 使用 uinput 作为优先真实输入后端, X11 可增加 XTest fallback, Wayland 按 compositor 和 portal 能力协商.

## 9. 仓库结构

```text
emacs-operator/
├── AGENTS.md
├── README.md
├── LICENSES/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
│   ├── architecture.md
│   ├── protocol.md
│   ├── security.md
│   ├── testing.md
│   └── adr/
├── skills/
│   └── emacs-native-operator/
│       ├── SKILL.md
│       ├── references/
│       │   ├── operation-model.md
│       │   ├── tool-contracts.md
│       │   ├── lisp-workflows.md
│       │   ├── org-workflows.md
│       │   └── safety.md
│       └── assets/
├── packages/
│   ├── mcp-server/
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── tools/
│   │   │   ├── resources/
│   │   │   ├── sessions/
│   │   │   ├── policy/
│   │   │   ├── audit/
│   │   │   └── drivers/
│   │   └── test/
│   ├── protocol/
│   │   ├── src/
│   │   ├── schemas/
│   │   └── test/
│   ├── bridge-client/
│   │   ├── src/
│   │   └── test/
│   └── test-harness/
├── lisp/
│   ├── emacs-operator.el
│   ├── emacs-operator-bridge.el
│   ├── emacs-operator-observe.el
│   ├── emacs-operator-keys.el
│   ├── emacs-operator-transaction.el
│   ├── emacs-operator-policy.el
│   ├── adapters/
│   │   ├── emacs-operator-adapter-generic.el
│   │   ├── emacs-operator-adapter-lisp.el
│   │   ├── emacs-operator-adapter-org.el
│   │   ├── emacs-operator-adapter-sly.el
│   │   └── emacs-operator-adapter-cider.el
│   └── test/
├── apps/
│   └── macos-host/
│       ├── EmacsOperatorHost.xcodeproj
│       ├── Sources/
│       │   ├── App/
│       │   ├── IPC/
│       │   ├── Permissions/
│       │   ├── Input/
│       │   ├── Accessibility/
│       │   ├── Capture/
│       │   └── Audit/
│       └── Tests/
├── fixtures/
│   ├── elisp/
│   ├── common-lisp/
│   ├── clojure/
│   ├── org/
│   └── emacs-configs/
├── scripts/
│   ├── bootstrap-dev.sh
│   ├── run-emacs-test-instance.sh
│   ├── install-elisp-package.sh
│   └── package-mcpb.sh
└── .github/workflows/
```

## 10. Capability 与 Session 模型

### 10.1 Instance

Instance 表示一个运行中的 Emacs 进程. 必须包含:

- `instance_id`.
- PID.
- Emacs version.
- system type.
- window system.
- bridge protocol version.
- available adapters.
- GUI frame 数量.
- 是否为 daemon.
- heartbeat.

### 10.2 Session

Session 是 MCP Server 生成的显式 handle. Session 至少保存:

```ts
interface EmacsSession {
  sessionId: string;
  instanceId: string;
  defaultChannel: "semantic" | "internal_keys" | "native_keys";
  permissionProfile: string;
  target: {
    frameId?: string;
    windowId?: string;
    bufferId?: string;
    projectRoot?: string;
  };
  stateSeqAtOpen: number;
  createdAt: string;
  lastUsedAt: string;
  leaseOwner: string;
}
```

所有修改工具都必须接收 `session_id`. 不允许依赖某个全局 current buffer.

### 10.3 Stable Handles

Bridge 为 frame, window 和 buffer 分配稳定 handle:

- Buffer: buffer-local UUID, 生命周期与 buffer 一致.
- Frame: weak hash table 中的 UUID.
- Window: weak hash table 中的 UUID, window 被删除后 handle 失效.

返回 handle 时同时返回人类可读字段, 例如 buffer name, file path 和 frame title.

### 10.4 Capability Negotiation

Session 打开时返回:

```json
{
  "channels": {
    "semantic": true,
    "internal_keys": true,
    "native_keys": true
  },
  "features": {
    "screen_capture": true,
    "accessibility_trusted": true,
    "screen_recording_granted": false,
    "transactions": "multi_buffer",
    "org_adapter": true,
    "paredit": true,
    "sly": false,
    "cider": true
  }
}
```

Agent 不得假设 capability 存在.

## 11. MCP 对外工具契约

工具数量应保持有限, 通过参数表达操作类型. MVP 定义 13 个工具.

### 11.1 `emacs_instances`

用途: 发现可连接的 Emacs 实例.

输入:

```json
{}
```

输出: instance 列表, bridge 状态, native driver 状态.

风险等级: read-only.

### 11.2 `emacs_session_open`

用途: 打开显式 session 并锁定 target.

输入示例:

```json
{
  "selector": {
    "instance_id": "emacs-7b9629b4",
    "file": "/workspace/src/core.el"
  },
  "default_channel": "internal_keys",
  "permission_profile": "workspace_edit"
}
```

行为:

1. 连接 instance.
2. 打开或选择目标 buffer.
3. 返回 session id 和完整 capability.
4. 不得自动获得 native desktop lease.

### 11.3 `emacs_session_close`

释放 session, transaction 和 lease. 默认不关闭 Emacs buffer.

### 11.4 `emacs_observe`

用途: 获取结构化状态.

输入示例:

```json
{
  "session_id": "ses_01J...",
  "scope": ["compact", "context", "structure", "messages"],
  "around_chars": 1600,
  "since_state_seq": 1042
}
```

返回字段:

- `state_seq`.
- target handles.
- buffer name, path, mode, modified, read-only.
- point, mark, region, line, column.
- visible range.
- bounded context before and after point.
- minibuffer status and prompt.
- current command, last command, recent command log.
- syntax state.
- mode adapter state.
- messages since requested sequence.

默认禁止返回完整 buffer. 完整内容通过分页 resource 或显式 range 获取.

### 11.5 `emacs_capabilities`

用途: 查询命令, key binding, package 和 mode 能力.

操作类型:

- `describe_key`.
- `resolve_key`.
- `where_is_command`.
- `describe_command`.
- `list_mode_commands`.
- `list_adapters`.
- `check_feature`.

示例:

```json
{
  "session_id": "ses_01J...",
  "operation": "resolve_key",
  "key": "C-c C-x C-a"
}
```

### 11.6 `emacs_key_sequence`

用途: 执行按键或按键步骤.

输入示例:

```json
{
  "session_id": "ses_01J...",
  "channel": "internal_keys",
  "steps": [
    {"kind": "keys", "value": "C-M-f"},
    {"kind": "keys", "value": "M-("},
    {"kind": "text", "value": "when "}
  ],
  "precondition": {
    "expected_buffer_tick": 81,
    "expected_major_mode": "emacs-lisp-mode"
  },
  "verify": {
    "buffer_changed": true,
    "balanced_sexps": true
  }
}
```

规则:

- `internal_keys` 由 Emacs bridge 执行.
- `native_keys` 由 macOS driver 执行.
- 对于会同步读取 minibuffer 的操作, steps 必须包含完整输入直到命令返回, 例如 `M-x`, command text, `RET`.
- 任意失败都必须释放仍然按下的 modifier.

### 11.7 `emacs_command`

用途: 调用 interactive command 或受控函数.

```json
{
  "session_id": "ses_01J...",
  "command": "org-promote-subtree",
  "interactive": true,
  "prefix": null,
  "arguments": [],
  "precondition": {
    "expected_major_mode": "org-mode"
  }
}
```

`interactive=true` 时使用 command semantics. `interactive=false` 只允许调用 policy allowlist 中的函数.

### 11.8 `emacs_edit`

用途: 可靠处理大段文本和精确范围修改.

支持操作:

- `insert`.
- `replace_range`.
- `delete_range`.
- `apply_unified_diff`.
- `replace_buffer`, 仅明确授权.

所有范围必须使用 buffer position + buffer tick, 或 marker handle. 不接受只靠行号的破坏性修改.

### 11.9 `emacs_eval`

用途: 执行受控计算.

语言类型:

- `elisp`.
- `buffer_language`.
- `repl`.

默认 profile 禁止任意 Elisp. Mode adapter 可以暴露安全的 eval-defun, eval-region 和 test command.

### 11.10 `emacs_checkpoint`

建立 transaction checkpoint.

Scope:

- `buffer`.
- `buffers`.
- `files`.

返回 `checkpoint_id` 和涉及的 buffer tick, file hash, point, mark, modified flag.

### 11.11 `emacs_rollback`

回滚 checkpoint. 如果外部文件已被其他进程修改, 必须返回冲突, 不得覆盖.

### 11.12 `emacs_wait`

等待有界条件, 用于异步 process 和 UI 状态.

条件示例:

- buffer tick changed.
- minibuffer active or inactive.
- buffer name matches.
- process output contains regex.
- command log contains command.
- mode becomes active.

最大 timeout 必须由配置限制, MVP 建议不超过 10 秒.

### 11.13 `emacs_capture`

用途: 捕获 Emacs window 图像用于视觉验证.

输入:

```json
{
  "session_id": "ses_01J...",
  "target": "selected_frame",
  "max_width": 1600,
  "include_cursor": false
}
```

仅在 screen capture capability 存在时可用. 默认不自动截图.

## 12. MCP Resources 与 Prompts

### 12.1 Resources

建议暴露:

```text
emacs://instances
emacs://session/{session_id}/state
emacs://session/{session_id}/commands
emacs://session/{session_id}/messages
emacs://session/{session_id}/buffer/{buffer_id}?start={n}&end={n}
emacs://session/{session_id}/org-tree
emacs://session/{session_id}/lisp-structure
```

Resources 适合读取大块上下文, Tools 适合执行动作.

### 12.2 Prompts

提供以下可复用 prompt:

- `edit_lisp_structurally`.
- `write_org_document`.
- `debug_with_repl`.
- `operate_emacs_package`.
- `verify_real_keyboard_behavior`.

## 13. 标准 Tool Result Envelope

所有工具统一返回:

```json
{
  "ok": true,
  "request_id": "req_01J...",
  "session_id": "ses_01J...",
  "state_before": {
    "state_seq": 1042,
    "buffer_tick": 81
  },
  "state_after": {
    "state_seq": 1045,
    "buffer_tick": 84
  },
  "result": {},
  "warnings": [],
  "audit_id": "aud_01J..."
}
```

失败返回:

```json
{
  "ok": false,
  "error": {
    "code": "E_STATE_CONFLICT",
    "message": "Buffer changed after the agent observed it.",
    "retryable": true,
    "details": {
      "expected_buffer_tick": 81,
      "actual_buffer_tick": 86
    },
    "recovery": "Call emacs_observe and re-plan the edit."
  }
}
```

## 14. Emacs Bridge 设计

### 14.1 生命周期

Bridge package 加载后执行:

1. 创建 runtime directory.
2. 生成 instance id 和 256-bit token.
3. 启动 loopback server, 使用随机端口.
4. 写 instance record 和 token file.
5. 注册 command hooks, buffer hooks, window hooks 和 minibuffer hooks.
6. 每 5 秒更新 heartbeat.
7. Emacs 退出时删除 instance record.

入口:

```elisp
(require 'emacs-operator)
(emacs-operator-mode 1)
```

### 14.2 协议 framing

每条消息:

```text
Content-Length: 123\r\n
Content-Type: application/json\r\n
\r\n
{...123 bytes...}
```

Process filter 必须支持:

- header 被拆分到多个 chunk.
- body 被拆分到多个 chunk.
- 同一个 chunk 包含多条消息.
- UTF-8 byte length, 不是字符数.
- 单条消息大小上限.

### 14.3 Bridge 方法

最低实现方法:

```text
initialize
ping
instance.describe
session.target.resolve
state.observe
capabilities.query
keys.execute
command.execute
edit.apply
checkpoint.create
checkpoint.commit
checkpoint.rollback
wait.condition
resource.read
```

### 14.4 Target Context

任何执行都必须显式进入目标上下文:

```elisp
(with-selected-frame target-frame
  (with-current-buffer target-buffer
    (with-selected-window target-window
      ...)))
```

如果 target window 不存在, 但 buffer 存在:

- `semantic` 操作可以只进入 buffer.
- `internal_keys` 必须选择或创建一个可用 window, 因为 active keymap 和 window state 可能依赖 selected window.

不得默认改变用户当前选中 window. Session 可以选择:

- `preserve_user_selection=true`, 执行结束后恢复用户 selection.
- `follow_agent=true`, 保持 Agent 最后的 selection.

默认 `preserve_user_selection=true`.

### 14.5 Internal Key Execution

Bridge 必须支持两种 key 输入形式:

1. Emacs notation, 例如 `C-c C-x C-a`, `C-M-f`, `<left>`, `RET`.
2. Structured event, 例如 modifiers + logical key + text.

Emacs notation 使用 `kbd` 或 `read-kbd-macro` 解析. 执行使用 `execute-kbd-macro`.

关键要求:

- 在执行前插入 undo boundary.
- 动态绑定 Agent source 标记.
- 捕获 `quit`, `user-error`, 普通 error.
- 执行后采集 `this-command`, `last-command`, point, buffer tick 和 message.
- 对自包含 synchronous minibuffer flow, 将完整事件序列一次性注入.
- 不允许只执行 `M-x` 后返回, 因为 Emacs 会等待后续输入.

结构化 text 事件必须允许 Unicode. 对于大量文本, `emacs_edit` 优于逐字符事件.

### 14.6 Command Execution

`interactive=true`:

- 验证 `commandp`.
- 使用 `command-execute` 或 `call-interactively`.
- 正确传递 prefix argument.
- 记录 command history.

`interactive=false`:

- 只允许 allowlist.
- 参数必须经过类型和大小校验.
- 禁止传入任意 Lisp object reader string.

### 14.7 State Observation

`state.observe` 至少返回:

```text
Instance:
  pid, version, system-type, window-system

Frame:
  id, name, visible, selected, dimensions

Window:
  id, start, end, point, dedicated, selected

Buffer:
  id, name, file, project-root, size, modified, read-only
  major-mode, minor-modes, buffer-tick, narrowing

Cursor:
  point, line, column, mark, region-active, region-bounds

Context:
  bounded text before and after point
  visible text range

Syntax:
  parse depth, in-string, in-comment
  defun bounds, sexp bounds when available

Interaction:
  minibuffer active, prompt, contents
  current command, last command, current prefix
  transient map present

Messages:
  message log delta
  process output delta
```

必须对 text 字段执行长度限制. 默认 compact observe 建议小于 32 KB.

### 14.8 State Sequence

Bridge 维护单调递增 `state_seq`. 以下事件增加序号:

- pre-command.
- post-command.
- buffer character change.
- window configuration change.
- selected buffer change.
- minibuffer setup and exit.
- process output, 可按节流合并.

每个 buffer 还返回 `buffer-chars-modified-tick`.

### 14.9 Command Audit Hooks

记录:

- timestamp.
- source: `human`, `rpc`, `internal_keys`, `native_keys`.
- command symbol.
- key sequence.
- target handles.
- point before and after.
- buffer tick before and after.
- success or error.

日志不记录完整敏感 buffer 内容. Diff 日志受 policy 控制.

### 14.10 Minibuffer

Bridge 必须观察:

- 是否有 active minibuffer.
- prompt.
- current contents.
- completion category, 如果可用.
- recursive minibuffer depth.

Agent 遇到未知 prompt 时必须停止后续破坏性操作并 observe. 不允许通过猜测连续发送 `RET`.

### 14.11 Async Process 与 REPL

Bridge 为 process buffer 维护增量 output cursor. `emacs_wait` 可以等待:

- prompt regex.
- process status.
- output regex.
- buffer tick.

REPL adapter 不得仅用 sleep. 必须使用条件等待和 timeout.

### 14.12 Transaction

优先使用 Emacs change group:

1. 为目标 buffer 执行 `prepare-change-group`.
2. 激活 change group.
3. 执行动作.
4. 验证通过后 accept.
5. 失败时 cancel.

对于跨多次 tool call 的长 transaction, 还必须记录:

- file content hash.
- buffer tick.
- undo boundary.
- point and mark markers.
- modified flag.

MVP transaction 级别:

- 单 buffer atomic action.
- 多 buffer checkpoint.
- 文件保存前 hash 冲突检测.

不承诺回滚外部进程副作用, Git commit, 网络请求或 REPL 中已经执行的业务操作. Tool result 必须明确标记不可逆副作用.

## 15. Canonical Key Model

### 15.1 为什么不能把 Meta 简单等同于 Option

Emacs 中的 `C`, `M`, `S`, `s`, `H`, `A` 是 Emacs event modifier. macOS 物理键的 Command, Option, Control, Shift 如何映射到这些 modifier, 取决于 Emacs build 和用户配置.

因此 `native_keys` 必须从 bridge 获取 modifier mapping, 包括但不限于:

- Command 对应 super, meta 或其他 modifier.
- Option 对应 meta, none 或输入特殊字符.
- 左右 Option 是否不同.
- 用户是否通过 ESC 前缀输入 Meta.

如果无法可靠映射 Meta, `native_keys` SHOULD 使用 ESC prefix 发送 `M-x` 形式, 而不是强行发送 Option+X.

### 15.2 事件结构

```ts
interface CanonicalKeyEvent {
  kind: "key_down" | "key_up" | "key_press" | "text";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: Array<"control" | "meta" | "shift" | "super" | "hyper" | "alt" | "command" | "option" | "fn">;
  repeat?: number;
  delayAfterMs?: number;
}
```

### 15.3 Key Coverage

MVP 必须覆盖:

- A-Z, 0-9.
- punctuation.
- Control, Shift, Option, Command.
- Escape, Return, Tab, Space, Backspace, Delete.
- Arrow keys, Home, End, Page Up, Page Down.
- F1-F12.
- keypad 基础键.

MVP 不要求 media keys 和厂商扩展键.

### 15.4 Text Input Modes

`text` 支持:

- `semantic_insert`: 直接插入, 最可靠.
- `internal_events`: 在 Emacs 内部逐字符输入, 可触发 self-insert hooks 和 electric behavior.
- `native_unicode`: macOS CGEvent Unicode string.
- `native_keymap`: 按当前键盘布局生成物理按键.
- `clipboard_paste`: 非默认, 必须保存并恢复 clipboard.

默认策略:

- 大段代码和文档使用 `semantic_insert`.
- 需要触发 electric pair, abbrev 或输入法行为时使用 event mode.
- 测试真实键盘布局时才使用 `native_keymap`.

### 15.5 Step Sequence

```json
{
  "steps": [
    {"kind": "keys", "value": "C-x C-f"},
    {"kind": "text", "value": "/tmp/demo.org"},
    {"kind": "keys", "value": "RET"},
    {"kind": "expect", "condition": {"major_mode": "org-mode"}}
  ]
}
```

在 `internal_keys` 中, 同步 prompt 之前的 key 和 prompt 回答应编译为同一个 macro. `expect` 只在 command 已返回后执行.

## 16. macOS Host 设计

### 16.1 App 结构

```text
EmacsOperatorHost.app
├── PermissionManager
├── DriverIPCServer
├── EmacsProcessLocator
├── AccessibilityWindowService
├── FocusManager
├── CGEventInputService
├── InputInterferenceMonitor
├── ScreenCaptureService
├── ClipboardGuard
└── MenuBarStatusUI
```

Host app 可以是无 Dock 图标的 menu bar app, 但必须提供一个可见状态窗口用于:

- 展示 Accessibility 权限.
- 展示 Screen Recording 权限.
- 展示当前连接状态.
- 停止所有 Agent 控制.
- 打开日志目录.

### 16.2 权限

Host app 启动时只检查权限, 不应在每次调用弹窗.

权限状态:

```text
unknown
not_requested
denied
granted
restricted
```

Accessibility 使用系统受信任检查 API. Screen capture 使用 ScreenCaptureKit 能力检查和实际请求流程. 权限缺失时返回稳定错误码, 并由 UI 引导用户打开系统设置.

### 16.3 Focus 流程

native action 前必须:

1. 通过 bridge 获取 Emacs PID 和目标 frame metadata.
2. 通过 `NSRunningApplication` 激活对应进程.
3. 通过 Accessibility API 找到目标 window.
4. raise 并设置 focused/main window.
5. 再次验证 frontmost PID.
6. 获取 native input lease.
7. 发送事件.
8. 验证 Emacs bridge 记录了预期 command 或 state change.
9. 根据请求决定是否恢复之前的 frontmost app.

任一步失败都不得发送按键.

### 16.4 CGEvent 输入

输入服务必须:

- 为每个 key 生成配对的 key down 和 key up.
- 在失败, timeout 和取消时释放所有按下 modifier.
- 支持 flags.
- 支持 virtual key code.
- 支持 Unicode text event.
- 支持可配置 inter-key delay.
- 在 event source user data 中写入本系统 tag.
- 记录实际发送数量和时间.

### 16.5 用户并发输入检测

Host 建立 event tap 或等价监控. native lease 期间检测非本系统 tag 的键盘或鼠标输入.

策略:

- 默认 `abort`.
- 可配置 `pause`.
- 测试环境可以 `ignore`, 生产默认禁止.

检测到用户输入后:

1. 立即停止后续事件.
2. 释放 modifier.
3. 返回 `E_USER_INTERFERENCE`.
4. 不自动重试.

### 16.6 Screen Capture

使用 ScreenCaptureKit:

- 枚举 shareable content.
- 按 PID 和 window metadata 选择 Emacs window.
- 生成 PNG.
- 默认缩放至合理上限.
- 默认自动删除临时图像.
- 审计日志不保存图像正文.

Screenshot 是辅助观察通道. 如果 bridge 能提供结构化状态, Agent 不应优先截图.

### 16.7 Driver IPC

MCP Server 与 Host app 使用本地 socket 和 token. 接口:

```text
driver.initialize
driver.capabilities
driver.permissions
driver.focus
driver.key_sequence
driver.type_text
driver.capture
driver.frontmost
driver.cancel_all
```

Driver 与 Bridge 使用相同 result envelope 风格, 但协议版本独立.

### 16.8 签名与发布

- 使用稳定 bundle identifier.
- Development 和 Release 使用不同但稳定的 bundle identifier.
- Release build 必须 code sign.
- 正式分发建议 notarize.
- 不得在每次本地构建时随机改变签名身份, 否则 TCC 授权会变得不稳定.

## 17. Agent 操作策略

### 17.1 标准循环

```text
1. emacs_instances
2. emacs_session_open
3. emacs_observe
4. emacs_capabilities, 如果命令或按键不确定
5. emacs_checkpoint
6. 执行 semantic, internal_keys 或 native_keys
7. emacs_observe
8. 验证结构, buffer tick, message 和测试结果
9. commit checkpoint, 或 rollback
10. emacs_session_close
```

### 17.2 通道选择表

| 任务 | 推荐通道 |
|---|---|
| 读取 buffer 和结构 | semantic |
| 插入大量代码或 Org 文本 | semantic |
| 调用已知 interactive command | semantic command |
| 验证用户 key binding | internal_keys |
| 使用 paredit slurp, barf, splice | internal_keys 或 semantic command |
| 操作 Org subtree | semantic command 或 internal_keys |
| M-x + minibuffer 流程 | internal_keys |
| 测试 macOS 键盘映射 | native_keys |
| 验证真正的前台 GUI 行为 | native_keys + capture |

### 17.3 禁止行为

Agent 不得:

- 在没有 observe 的情况下修改 buffer.
- 假设 `M-x` 或其他键位没有被用户重映射.
- native 模式下不验证 frontmost PID 就发送输入.
- 遇到未知 minibuffer prompt 时连续敲 `RET`.
- 在 transaction 失败后继续修改.
- 默认执行任意 Elisp.
- 通过截图猜测能够直接读取的 buffer 状态.

## 18. Mode Adapter

### 18.1 Adapter 接口

```elisp
(cl-defgeneric emacs-operator-adapter-applicable-p (adapter context))
(cl-defgeneric emacs-operator-adapter-observe (adapter context))
(cl-defgeneric emacs-operator-adapter-capabilities (adapter context))
(cl-defgeneric emacs-operator-adapter-verify (adapter action before after))
```

Adapter 不替换 Emacs command. 它提供:

- mode-specific state.
- 推荐能力.
- 参数校验.
- postcondition verification.
- 恢复建议.

### 18.2 Generic Adapter

提供:

- buffer and window operations.
- key resolution.
- command descriptions.
- search and navigation.
- save and revert.

### 18.3 Lisp Adapter

适用 mode:

- emacs-lisp-mode.
- lisp-mode.
- lisp-interaction-mode.
- scheme-mode.
- clojure-mode.

观察:

- current defun bounds.
- current sexp bounds.
- `syntax-ppss` depth.
- string or comment state.
- package or namespace, 如果 adapter 可获取.
- paredit, smartparens 等 minor mode 状态.

能力:

- forward/backward sexp.
- slurp, barf, splice, wrap.
- raise sexp.
- split/join sexp.
- indent defun or region.
- eval last sexp, defun, region.
- compile or test.

验证:

- `check-parens`.
- parse depth 未异常变化.
- point 位于预期结构.
- eval 或 compile result.

Paredit 不存在时不得假装执行 paredit. 可以降级到 built-in sexp commands, 并返回 warning.

### 18.4 Org Adapter

观察:

- current heading.
- heading level.
- outline path.
- TODO state.
- tags.
- property drawer.
- subtree bounds.
- element context.
- Babel block context.

能力:

- insert heading.
- promote or demote heading/subtree.
- move subtree up or down.
- set TODO.
- set property.
- create ID.
- archive subtree.
- edit table.
- execute Babel block, 受 policy 控制.
- export.

验证:

- `org-element` parse 成功.
- heading tree 层级符合预期.
- property drawer 未被破坏.
- subtree bounds 仍有效.

### 18.5 SLY 和 CIDER Adapter

必须将 REPL connection 作为显式状态返回. 操作前确认:

- connection exists.
- target package or namespace.
- process alive.
- prompt ready.

Eval result 必须包含 stdout, stderr, value, condition 和 backtrace handle.

## 19. 安全设计

### 19.1 Permission Profiles

```yaml
observe_only:
  observe: true
  edit: false
  internal_keys: false
  native_keys: false
  eval: false

workspace_edit:
  observe: true
  edit: true
  save_within_roots: true
  internal_keys: true
  native_keys: false
  safe_eval: true
  arbitrary_elisp: false

workspace_developer:
  observe: true
  edit: true
  internal_keys: true
  native_keys: false
  repl_eval: true
  process_commands: allowlist
  arbitrary_elisp: false

desktop_control:
  inherit: workspace_developer
  native_keys: true
  capture: true
  restore_frontmost: true

unrestricted_dev:
  inherit: desktop_control
  arbitrary_elisp: true
  warning: development_only
```

### 19.2 Workspace Boundary

- 通过 canonical path 检查 project root.
- 处理 symlink 后再校验.
- 保存, 删除, rename 和 external process cwd 不得逃逸 root.
- TRAMP buffer 默认 observe-only, 除非显式启用 remote policy.

### 19.3 Arbitrary Elisp

任意 Elisp 等同于在用户账户下执行任意代码. 默认关闭.

替代方案:

- allowlisted command.
- typed semantic operation.
- adapter operation.
- 受限 expression evaluator, 只允许纯函数, 可在后续实现.

### 19.4 Native Desktop Control

native control 必须:

- 用户显式授予 Accessibility.
- session profile 允许.
- 当前调用明确指定 `native_keys`.
- 获取 global desktop lease.
- 验证 frontmost PID.
- 检测用户输入.

### 19.5 Network

- Bridge 只绑定 loopback.
- Driver socket 只对当前用户开放.
- token 至少 256 bit.
- token 不写入普通日志.
- HTTP remote transport 不属于 MVP.

### 19.6 Screenshot Privacy

- capture 默认关闭.
- 图像只保存到 runtime temp.
- 默认在 tool result 消费后删除.
- 不上传外部服务.
- 日志只记录 hash, size 和 metadata.

## 20. 并发与可靠性

### 20.1 Lock

- 每个 Emacs instance 有一个 mutation lock.
- 每个 buffer 可以有更细粒度 lock, 但 MVP 可以先使用 instance lock.
- native desktop control 有全局 lock.
- read-only observe 不占 mutation lock.

### 20.2 State Conflict

如果 `expected_buffer_tick` 或 `expected_state_seq` 不匹配, 返回 `E_STATE_CONFLICT`. Agent 必须重新 observe 和规划.

### 20.3 Idempotency

Mutating tool 接收 `request_id`. Server 在短期内缓存已完成 request 的结果. 相同 request id 不得重复执行.

### 20.4 Timeout

每个层级独立 timeout:

- MCP tool timeout.
- Bridge request timeout.
- Command execution timeout.
- Wait condition timeout.
- Native focus timeout.
- Native key sequence timeout.

Timeout 后必须取消未完成动作并释放资源.

### 20.5 Crash Recovery

MCP Server 重启后:

- session 丢失是允许的.
- instance record 仍可重新发现.
- stale lock 根据进程存活和 lease TTL 清理.
- 未 commit 的跨调用 transaction 标记为 abandoned, 不自动覆盖文件.

Emacs crash 后:

- Bridge connection 断开.
- Tool 返回 `E_EMACS_DISCONNECTED`.
- 不自动启动新的 Emacs 并继续旧 transaction.

### 20.6 Human-in-the-loop

用户在 Emacs 中手动编辑时, buffer tick 会变化. Agent 应把这种变化当成真实协作输入, 而不是错误噪声.

## 21. 配置设计

示例:

```yaml
server:
  transport: stdio
  log_level: info
  max_tool_timeout_ms: 15000

bridge:
  discovery_dir: auto
  connect_timeout_ms: 2000
  max_message_bytes: 4194304
  observe_default_chars: 1600

sessions:
  default_permission_profile: workspace_edit
  idle_ttl_minutes: 30
  preserve_user_selection: true

transactions:
  default: auto
  file_snapshot_max_bytes: 10485760

native_macos:
  enabled: true
  driver_socket: auto
  focus_timeout_ms: 2000
  inter_key_delay_ms: 8
  restore_frontmost: true
  on_user_input: abort
  capture_enabled: false

security:
  allowed_roots:
    - "~/Projects"
  allow_tramp: false
  arbitrary_elisp: false
  audit_log: true
  audit_diff_content: false
```

配置必须有 JSON Schema 并在启动时严格校验.

## 22. 实施阶段与任务分解

### Phase 0: 仓库和协议基线

目标: 创建可编译, 可测试的 monorepo.

任务:

- `P0-001`: 创建 pnpm workspace 和 TypeScript 基线.
- `P0-002`: 创建 protocol package, 定义 result envelope, error codes 和 shared types.
- `P0-003`: 创建 JSON Schema, 加入 schema validation tests.
- `P0-004`: 创建最小 MCP stdio server, 暴露 health tool.
- `P0-005`: 创建 Emacs Lisp package skeleton 和 ERT runner.
- `P0-006`: 创建 macOS Xcode project skeleton.
- `P0-007`: 建立 CI, 至少运行 TypeScript 和 ERT tests.
- `P0-008`: 创建 ADR 目录和 STATUS.md.

Exit criteria:

- `pnpm test` 通过.
- Emacs batch ERT 通过.
- MCP Inspector 能看到 health tool.

### Phase 1: Emacs Bridge 基础

任务:

- `P1-001`: runtime directory 和 instance record.
- `P1-002`: token generation 和权限校验.
- `P1-003`: loopback TCP server.
- `P1-004`: Content-Length parser.
- `P1-005`: JSON-RPC dispatcher.
- `P1-006`: initialize, ping, instance.describe.
- `P1-007`: heartbeat 和 stale cleanup.
- `P1-008`: buffer, frame, window stable handles.
- `P1-009`: state_seq.
- `P1-010`: state.observe compact.

Exit criteria:

- Node bridge client 可以发现并连接 `emacs -Q` test instance.
- 分片 framing tests 通过.
- 可以读取当前 buffer, mode, point 和 context.

### Phase 2: MCP Session 与 Policy

任务:

- `P2-001`: bridge discovery client.
- `P2-002`: `emacs_instances`.
- `P2-003`: session manager.
- `P2-004`: `emacs_session_open/close`.
- `P2-005`: target resolution.
- `P2-006`: permission profiles.
- `P2-007`: audit log.
- `P2-008`: tool result envelope.
- `P2-009`: request idempotency.
- `P2-010`: conflict preconditions.

Exit criteria:

- 两个 Emacs 实例可被准确区分.
- session 明确锁定目标 buffer.
- 越权操作被 policy 拒绝.

### Phase 3: Semantic 操作

任务:

- `P3-001`: `emacs_observe` 完整字段.
- `P3-002`: `emacs_capabilities`.
- `P3-003`: `emacs_command`.
- `P3-004`: `emacs_edit` insert/replace/delete.
- `P3-005`: unified diff application.
- `P3-006`: checkpoint and rollback.
- `P3-007`: file hash conflict check.
- `P3-008`: `emacs_wait`.
- `P3-009`: process output cursor.

Exit criteria:

- 可以在后台修改 buffer, 调用 command, 保存, 回滚.
- 冲突时不覆盖用户修改.

### Phase 4: Internal Key Channel

任务:

- `P4-001`: Emacs kbd notation parser wrapper.
- `P4-002`: structured key event compiler.
- `P4-003`: `execute-kbd-macro` executor.
- `P4-004`: command source tagging.
- `P4-005`: complete minibuffer macro flow.
- `P4-006`: error and quit handling.
- `P4-007`: pre/post verification.
- `P4-008`: internal Unicode text events.
- `P4-009`: key-binding capability queries.

Exit criteria:

- Emacs 不在前台时可以通过 key sequence 执行 Org 和 paredit 命令.
- `C-x C-f`, file path, `RET` 可以完整工作.
- 自定义 key binding 被正确解析.

### Phase 5: Lisp 与 Org Adapter

任务:

- `P5-001`: generic adapter registry.
- `P5-002`: Lisp structural observe.
- `P5-003`: paredit capabilities.
- `P5-004`: Lisp postcondition checks.
- `P5-005`: Org tree observe.
- `P5-006`: Org semantic commands.
- `P5-007`: Org postcondition checks.
- `P5-008`: fixtures 和 workflow tests.
- `P5-009`: SLY/CIDER adapter skeleton.

Exit criteria:

- Lisp fixture 完成 slurp, barf, wrap, splice 后 `check-parens` 通过.
- Org fixture 完成 insert, promote, demote, move, TODO, property 后 tree 与 drawer 正确.

### Phase 6: macOS Host 基础

任务:

- `P6-001`: stable app bundle 和 status UI.
- `P6-002`: permission manager.
- `P6-003`: local driver IPC.
- `P6-004`: process discovery by PID.
- `P6-005`: frontmost application query.
- `P6-006`: Accessibility window discovery.
- `P6-007`: focus and raise.
- `P6-008`: driver capability tool wiring.

Exit criteria:

- Host app 能展示权限状态.
- MCP Server 能连接 driver.
- 能把指定 Emacs 进程和 window 置前并验证 PID.

### Phase 7: macOS Native Input

任务:

- `P7-001`: virtual key mapping.
- `P7-002`: modifier mapping.
- `P7-003`: CGEvent key down/up.
- `P7-004`: Unicode text.
- `P7-005`: event tagging.
- `P7-006`: user interference monitor.
- `P7-007`: global desktop lease.
- `P7-008`: key release on failure.
- `P7-009`: restore previous application.
- `P7-010`: bridge-based post verification.

Exit criteria:

- 从非 Emacs 前台状态开始, Host 激活 Emacs, 执行真实组合键, Bridge 观察到预期 command.
- 用户按键介入时 native sequence 中止.

### Phase 8: Capture 与视觉验证

任务:

- `P8-001`: ScreenCaptureKit content discovery.
- `P8-002`: select Emacs window.
- `P8-003`: PNG capture and scaling.
- `P8-004`: MCP image result.
- `P8-005`: temp cleanup.
- `P8-006`: permission error UX.

Exit criteria:

- 可以捕获指定 Emacs window.
- 未授权时返回清晰错误.
- 临时图像按策略删除.

### Phase 9: Packaging 和 Beta

任务:

- `P9-001`: 完成目标 `SKILL.md` 和 references.
- `P9-002`: install script.
- `P9-003`: Emacs package installation instructions.
- `P9-004`: MCP client configs.
- `P9-005`: signed release build.
- `P9-006`: notarization pipeline, 如果进入正式分发.
- `P9-007`: MCPB packaging spike.
- `P9-008`: user documentation.
- `P9-009`: security review.

Exit criteria:

- 新机器可以按文档安装.
- Agent 可以发现 skill 和 tools.
- 完成第 24 章验收测试.

## 23. 测试策略

### 23.1 TypeScript Unit Tests

覆盖:

- schema validation.
- result envelope.
- error mapping.
- session TTL.
- target handle parsing.
- permission profiles.
- idempotency.
- conflict checks.
- key event serialization.
- bridge framing parser.

### 23.2 ERT Tests

覆盖:

- Content-Length parser split cases.
- auth failure.
- stable handles.
- observe fields.
- state_seq increments.
- internal key sequence.
- minibuffer self-contained flow.
- command execution.
- buffer edit.
- change group rollback.
- Org adapter.
- Lisp adapter.

### 23.3 Integration Tests

每次启动隔离 Emacs:

```text
emacs -Q --daemon=emacs-operator-test
```

加载 fixture config 和 bridge. 测试过程不得依赖开发者个人 Emacs 配置.

关键用例:

1. 后台 Emacs 中执行 `C-x C-f`, 输入 fixture path, `RET`.
2. 自定义绑定 `C-c z` 到测试 command, internal key 正确触发.
3. paredit slurp 后结果文本完全匹配 fixture.
4. Org subtree promote/demote 后 outline tree 正确.
5. Agent observe 后人工模拟修改, 原 edit 返回 conflict.
6. checkpoint 后连续操作失败, rollback 恢复原文本.
7. 两个 session 争用同一 instance, 第二个 mutation 被锁拒绝.

### 23.4 macOS Native Manual/E2E Tests

TCC 和真实桌面焦点测试需要专用 runner 或手工测试:

1. Accessibility 未授权.
2. 授权后重新检测.
3. Emacs 已最前.
4. Emacs 在后台, 先 focus 后输入.
5. target window 标题冲突.
6. US keyboard layout.
7. 中文输入法开启时发送 Emacs command chord.
8. Unicode text input.
9. 用户输入干预.
10. 事件中途 driver crash, modifier 释放.
11. restore previous app.
12. screen capture 未授权和已授权.

### 23.5 性能基线

在本机 loopback 条件下建议:

- compact observe median < 50 ms.
- bridge ping median < 20 ms.
- 1 KB semantic insert median < 100 ms.
- internal single chord overhead < 100 ms, 不含命令自身耗时.
- MCP Server idle memory < 150 MB.
- observe 默认 payload < 32 KB.

这些是工程目标, 不是协议保证. CI 应记录趋势而不是对共享 runner 使用过严 hard fail.

## 24. MVP 验收标准

以下全部通过才算 macOS MVP 完成:

### A. 后台 Internal Keys

- Emacs window 不在前台.
- Agent 打开 session 并选择 Lisp buffer.
- Agent 执行 `internal_keys` 的 paredit 操作.
- 当前 keymap 中真实绑定被触发.
- Buffer 结果正确, `check-parens` 通过.

### B. Org 操作

- Agent 创建 heading.
- 调整 heading 层级.
- 移动 subtree.
- 设置 TODO 和 property.
- Property drawer 和 outline tree 未损坏.

### C. Minibuffer

- 使用 internal key sequence 完成 `C-x C-f` 全流程.
- Agent 能观察最终 buffer 和 mode.

### D. Native Keys

- Safari 或 Finder 位于前台.
- Agent 获得 desktop lease.
- Host app 激活指定 Emacs window.
- Host 通过 CGEvent 发送真实组合键.
- Bridge command log 观察到预期 command.
- 操作后可恢复原 frontmost app.

### E. 冲突和恢复

- Agent observe 后, 用户修改 buffer.
- Agent 的旧 precondition 操作被拒绝.
- 新 observe 后可以重新计划.
- 一个失败 transaction 可以 rollback.

### F. 安全

- 未授权 arbitrary Elisp 被拒绝.
- workspace 外保存被拒绝.
- native permission 缺失时不发送按键.
- 日志不包含 token.
- Bridge 不监听外部网卡.

### G. 安装与文档

- 新用户可以安装 Elisp package.
- Host app 显示权限状态.
- MCP client 可以启动 server.
- Skill 可以被兼容的 Agent 发现.

## 25. 错误码

最低错误码集合:

```text
E_INVALID_ARGUMENT
E_SCHEMA_VALIDATION
E_AUTH_FAILED
E_INSTANCE_NOT_FOUND
E_EMACS_DISCONNECTED
E_SESSION_NOT_FOUND
E_SESSION_EXPIRED
E_TARGET_NOT_FOUND
E_TARGET_STALE
E_STATE_CONFLICT
E_MUTATION_LOCKED
E_PERMISSION_DENIED
E_POLICY_DENIED
E_COMMAND_NOT_FOUND
E_COMMAND_NOT_INTERACTIVE
E_COMMAND_FAILED
E_COMMAND_QUIT
E_KEY_PARSE_FAILED
E_KEY_UNBOUND
E_MINIBUFFER_UNEXPECTED
E_COMMAND_TIMEOUT
E_WAIT_TIMEOUT
E_TRANSACTION_NOT_FOUND
E_TRANSACTION_CONFLICT
E_ROLLBACK_FAILED
E_NATIVE_DRIVER_UNAVAILABLE
E_ACCESSIBILITY_NOT_GRANTED
E_SCREEN_CAPTURE_NOT_GRANTED
E_FOCUS_FAILED
E_FRONTMOST_MISMATCH
E_USER_INTERFERENCE
E_INPUT_INJECTION_FAILED
E_CAPTURE_FAILED
E_EXTERNAL_SIDE_EFFECT
E_INTERNAL
```

每个错误码必须有:

- HTTP-like category, 即使 stdio 不使用 HTTP.
- retryable flag.
- default recovery message.
- structured details schema.

## 26. 跨平台扩展

### 26.1 保持不变的部分

以下组件在 Windows 和 Linux 保持不变:

- Agent Skill.
- MCP tools.
- session model.
- policy.
- audit.
- Emacs bridge.
- internal_keys.
- Lisp 和 Org adapters.
- tool result envelope.

因此即使没有 native driver, 系统仍可在所有 Emacs 支持平台上通过 semantic 和 internal_keys 工作.

### 26.2 Windows Driver

建议实现:

- Input: Win32 SendInput.
- Focus and window discovery: UI Automation + Win32 window APIs.
- Capture: Windows Graphics Capture.
- Integrity constraint: driver 必须报告 UIPI 限制, 不能向更高完整性级别进程注入.
- User interference: low-level keyboard and mouse hooks, 只做检测, 不做隐蔽监控.

Driver 接口与 macOS 完全一致.

### 26.3 Linux Driver

优先级:

1. `internal_keys`, 始终可用, 不依赖桌面协议.
2. uinput native input, 需要 `/dev/uinput` 权限和安全安装配置.
3. Window focus 和 capture 根据 Wayland compositor, portal 或 X11 capability 提供.

Linux driver 必须诚实报告 capability, 例如:

```json
{
  "native_keyboard": true,
  "window_focus": false,
  "window_capture": true,
  "reason": "Wayland compositor does not expose programmable focus control."
}
```

不得因为某个发行版支持就假设所有 Linux desktop 都支持相同能力.

### 26.4 Platform Driver Interface

```ts
interface PlatformDriver {
  initialize(): Promise<DriverCapabilities>;
  permissions(): Promise<PermissionState[]>;
  getFrontmostApplication(): Promise<ApplicationInfo>;
  focusEmacs(target: NativeTarget, options: FocusOptions): Promise<FocusResult>;
  sendKeySequence(sequence: NativeSequence): Promise<InputResult>;
  typeText(request: TextInputRequest): Promise<InputResult>;
  captureEmacs(target: NativeTarget, options: CaptureOptions): Promise<CaptureResult>;
  cancelAll(): Promise<void>;
}
```

## 27. 发布和版本管理

### 27.1 版本

独立版本:

- MCP server version.
- Bridge protocol version.
- Driver protocol version.
- Skill version.

握手必须协商兼容范围. 不允许只比较字符串相等.

### 27.2 MVP 发布物

- `emacs-operator-mcp-server`.
- `EmacsOperatorHost.app`.
- `emacs-operator.el` package.
- `emacs-native-operator` skill folder.
- 示例配置.
- 安装脚本.
- 测试报告.

### 27.3 分发路线

1. 开发期: local stdio + source install.
2. Alpha: npm package + signed macOS host zip.
3. Beta: installer + Emacs package archive.
4. 正式版: MCP Bundle 或等价本地安装包, notarized macOS app.

## 28. 主要风险与解决策略

| 风险 | 解决策略 |
|---|---|
| Emacs 不在前台, OS 输入发错应用 | internal_keys 为默认, native 前强制验证 PID |
| 用户同时键入 | desktop lease + interference monitor + buffer tick conflict |
| Meta/Option 映射不一致 | 从 Emacs 查询 modifier mapping, 必要时使用 ESC prefix |
| Minibuffer 阻塞 | synchronous flow 一次性注入完整事件, 提供 prompt observe |
| 第三方 package 状态复杂 | capability discovery + mode adapter + postcondition |
| 直接 Elisp 权限过大 | 默认 deny, command allowlist 和 typed operations |
| 截图泄露敏感信息 | 默认关闭, 临时存储, 自动删除, 不写正文日志 |
| TCC 授权在开发 build 中不稳定 | 稳定 bundle id, 稳定签名, 独立 Host app |
| 多 Agent 相互踩踏 | instance mutation lock, explicit session, state precondition |
| rollback 不完整 | 区分 buffer 可逆变更和 external irreversible side effect |
| Wayland 能力碎片化 | internal_keys 保底, driver capability negotiation |
| 全量 buffer 上下文过大 | bounded observe + range resource + delta state |

## 29. Definition of Done

一个任务只有同时满足以下条件才完成:

1. 代码实现与本规格一致.
2. 所有新增 public API 有 schema 和文档.
3. 所有错误路径有稳定错误码.
4. 单元测试和集成测试通过.
5. mutating action 有 precondition 和 audit.
6. 无 token, secret 或完整 screenshot 泄露到日志.
7. 对应阶段的 exit criteria 通过.
8. `STATUS.md` 已更新.
9. 架构偏差有 ADR.
10. 用户安装说明已在干净环境验证.

## 30. 编码 Agent 执行规则

编码 Agent 必须遵守:

1. 先实现 semantic 和 internal_keys, 再实现 native_keys.
2. 不得以截图 OCR 代替 Bridge state observe.
3. 不得用固定 sleep 代替有条件 wait, 除非 OS event pacing.
4. 不得硬编码用户快捷键.
5. 不得把 Emacs current buffer 当作跨调用稳定 target.
6. 不得在测试中使用开发者个人 `.emacs.d`.
7. 不得跳过权限失败和冲突测试.
8. 不得用 mock 宣称 native CGEvent 验收通过.
9. 不得在日志中记录 token 或任意 Elisp 原文.
10. 每个阶段提交一个可运行增量.
11. 遇到设计冲突时创建 ADR, 说明问题, 备选方案和选择理由.
12. 优先写最小可验证闭环, 不提前做 UI 装饰.

## 31. 参考实现骨架

### 31.1 TypeScript Bridge Client

```ts
export interface BridgeClient {
  connect(instance: EmacsInstanceRecord): Promise<void>;
  initialize(token: string): Promise<BridgeCapabilities>;
  request<TInput, TOutput>(
    method: string,
    input: TInput,
    options?: { timeoutMs?: number; requestId?: string },
  ): Promise<ToolEnvelope<TOutput>>;
  close(): Promise<void>;
}
```

### 31.2 TypeScript Mutation Guard

```ts
export interface MutationPrecondition {
  expectedStateSeq?: number;
  expectedBufferId?: string;
  expectedBufferTick?: number;
  expectedMajorMode?: string;
  expectedFrontmostPid?: number;
}
```

### 31.3 Elisp Method Registry

```elisp
(defvar emacs-operator--rpc-methods (make-hash-table :test #'equal))

(defun emacs-operator-register-method (name function)
  (puthash name function emacs-operator--rpc-methods))

(defun emacs-operator--dispatch (name params context)
  (let ((fn (gethash name emacs-operator--rpc-methods)))
    (unless fn
      (signal 'emacs-operator-method-not-found (list name)))
    (funcall fn params context)))
```

### 31.4 Internal Key Executor Skeleton

```elisp
(defun emacs-operator--execute-key-vector (window events)
  (let ((emacs-operator--command-source 'internal-keys))
    (with-selected-window window
      (undo-boundary)
      (condition-case err
          (progn
            (execute-kbd-macro events)
            (list :ok t
                  :last-command last-command
                  :point (point)
                  :buffer-tick (buffer-chars-modified-tick)))
        (quit
         (list :ok nil :error-code "E_COMMAND_QUIT" :data err))
        (error
         (list :ok nil :error-code "E_COMMAND_FAILED" :data err))))))
```

实际实现必须增加 target validation, transaction, context restore, output limits 和 audit.

### 31.5 Swift Driver Protocol

```swift
protocol DesktopDriver {
    func capabilities() async throws -> DriverCapabilities
    func permissions() async -> [PermissionState]
    func frontmostApplication() async throws -> ApplicationInfo
    func focusEmacs(_ target: NativeTarget, options: FocusOptions) async throws -> FocusResult
    func sendKeySequence(_ sequence: NativeSequence) async throws -> InputResult
    func captureEmacs(_ target: NativeTarget, options: CaptureOptions) async throws -> CaptureResult
    func cancelAll() async
}
```

## 32. 示例工作流

### 32.1 使用 paredit 修改函数

任务: 把后一个 S-expression 吸收到当前 list.

```text
1. Open session on Lisp buffer.
2. Observe point, syntax depth, current sexp and paredit capability.
3. Resolve current binding for paredit-forward-slurp-sexp.
4. Create checkpoint.
5. Execute command semantically, or execute its bound internal key.
6. Observe buffer tick and current defun.
7. Run check-parens.
8. Commit checkpoint.
```

不应直接通过字符串查找括号位置实现同一任务.

### 32.2 创建 Org 章节并移动 subtree

```text
1. Open session on Org buffer.
2. Observe current heading path and subtree bounds.
3. Create checkpoint.
4. Call org-insert-heading-respect-content or execute bound internal key.
5. Insert heading text semantically.
6. Call org-demote-subtree or internal key.
7. Move subtree.
8. Observe org tree and property drawer.
9. Commit.
```

### 32.3 验证真实 macOS 组合键

```text
1. Observe expected target and key binding.
2. Request native desktop lease.
3. Host records current frontmost app.
4. Host focuses target Emacs window and verifies PID.
5. Host sends CGEvent sequence.
6. Bridge verifies command log and state change.
7. Host restores previous app.
8. Release lease.
```

## 33. 官方技术依据

实现时优先查阅以下官方资料的当前版本:

- GNU Emacs Lisp Reference Manual: Keyboard Macros.
- GNU Emacs Lisp Reference Manual: Command Loop Overview.
- GNU Emacs Lisp Reference Manual: Interactive Call.
- GNU Emacs Lisp Reference Manual: Reading One Event.
- GNU Emacs Manual: Emacs Server and emacsclient.
- Apple Developer Documentation: CGEvent.
- Apple Developer Documentation: CGEvent keyboard event initializer.
- Apple Developer Documentation: AXIsProcessTrustedWithOptions.
- Apple Developer Documentation: ScreenCaptureKit and SCShareableContent.
- Model Context Protocol Specification, revision 2026-07-28.
- Model Context Protocol: stdio transport and Tools.
- Agent Skills open format specification.
- Microsoft Learn: SendInput, UI Automation, Windows Graphics Capture.
- Linux Kernel Documentation: uinput and input userspace API.

## 34. 最终架构结论

本项目最关键的实现判断是:

```text
真正有价值的不是让 LLM 只会按键,
而是让 LLM 同时拥有 Emacs 状态, Emacs 命令, Emacs 按键和 OS 真实输入.
```

`internal_keys` 是 paredit, org-mode 和绝大多数 Emacs package 的核心通道. 它保留 keymap 和 interactive behavior, 又不强制 Emacs 占据前台. `native_keys` 是验证和桌面自动化通道, 不是默认编辑通道. 这一划分既能获得真实 Emacs 能力, 又避免让整个系统变成一台容易把按键敲进 Safari 的盲眼打字机.
