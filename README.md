# codex-agent-bridge

让 **Codex（GPT 大脑做计划）** 通过 MCP 把执行任务**委派给本地多个 AI CLI** 的桥接器。

```
        ┌─────────────────────────────┐
        │  Codex (GPT 大脑，做计划)     │
        │  MCP host                   │
        └──────────────┬──────────────┘
                       │ MCP 工具调用
                       ▼
        ┌─────────────────────────────┐
        │  codex-agent-bridge (MCP srv)│
        │  delegate / delegate_xxx     │
        └───┬───────┬───────┬─────┬────┘
            ▼       ▼       ▼     ▼
         cline     dsh     omp  zcode / workbuddy
        （各自 spawn 对应 CLI，非交互执行，回传结果）
```

Codex 决定"做什么计划、派给谁"，本桥接器负责 spawn 对应的 agent CLI、以无人监督模式跑完、把输出回传给 Codex 汇总。

## 支持的 agent

| 工具 | 底层命令 | 非交互形式 | 备注 |
|---|---|---|---|
| `delegate_cline` | `cline` | `cline "<prompt>"` | 默认 act + auto-approve |
| `delegate_dsh` | `dsh` | `dsh --profile headless "<prompt>"` | 需已配置 headless profile |
| `delegate_omp` | `omp` | `omp -p "<prompt>"` | opencode / omp |
| `delegate_zcode` | `node zcode.cjs` | `zcode -p "<prompt>"` | 智谱 GLM 驱动 |
| `delegate_workbuddy` | `node codebuddy` | `codebuddy -p "<prompt>"` | 需先本机登录 |
| `delegate`（通用） | — | 传 `agent` 参数指定 | 一个工具覆盖全部 |

每个工具接受 `prompt`（必填）和可选 `cwd`（工作目录）。

### 关于 qoder

本机实测 `qoder` 的 `code.cmd` 是 **VSCode 系 IDE 启动器**（打开文件/文件夹），
不是"给 prompt 就改代码"的 AI agent，无法以非交互方式委派，故**未纳入**。
如果 Qoder 后续提供 headless CLI，可在 `index.js` 的 `AGENTS` 中按同格式添加。

## 安装

```bash
cd codex-agent-bridge
npm install
```

## 配置 Codex

编辑 `~/.codex/config.toml`，追加：

```toml
[mcp_servers.codex-agent-bridge]
command = "node"
args = ["D:\\Program Files\\Cline\\codex-agent-bridge\\index.js"]
```

> 把路径换成本仓库实际路径。`zcode` / `workbuddy` 默认指向本机安装路径，
> 换机器时用环境变量覆盖（见下）。

重启 Codex 后，它会看到 `delegate`、`delegate_cline`、`delegate_dsh`、
`delegate_omp`、`delegate_zcode`、`delegate_workbuddy` 这几个工具。

## 环境变量覆盖（换机器 / 自定义入口）

| 变量 | 作用 |
|---|---|
| `CLINE_BIN` | cline 命令或绝对路径 |
| `DSH_BIN` | dsh 命令或绝对路径 |
| `OMP_BIN` | omp 命令或绝对路径 |
| `ZCODE_BIN` | zcode.cjs 的绝对路径 |
| `WORKBUDDY_BIN` | codebuddy 入口的绝对路径 |
| `DELEGATE_TIMEOUT_MS` | 单次委派超时（毫秒，默认 600000） |
| `DELEGATE_MAX_OUT` | 回传输出的截断长度（默认 30000 字符） |

可在 Codex 的 MCP 配置里用 `env` 传入，例如：

```toml
[mcp_servers.codex-agent-bridge]
command = "node"
args = ["D:\\path\\to\\codex-agent-bridge\\index.js"]

[mcp_servers.codex-agent-bridge.env]
OMP_BIN = "omp"
DELEGATE_TIMEOUT_MS = "600000"
```

## 工作原理

- 基于官方 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol)，走 stdio。
- 三种 spawn 模式适配不同 CLI 形态：
  - `shell`：npm `.cmd` shim（cline / dsh），自行引号化参数；
  - `direct`：原生 `.exe`（omp）；
  - `node-script`：`node xxx.cjs`（zcode / workbuddy），用当前 node 运行。
- 超时后强杀进程树（Windows `taskkill /T /F`），避免悬挂。
- 日志只写 stderr，stdout 严格留给 MCP 协议。

## 安全提示

`cline`、`codebuddy` 等在无人监督模式下会**实际修改文件**。请仅在信任的仓库、
沙箱环境或已纳入版本控制的工作目录中使用，并自行确认下游 agent 的 auto-approve 行为。

## License

MIT
