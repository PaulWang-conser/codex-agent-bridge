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
| `delegate_cline` | `cline` | `cline -y "<prompt>"` | `-y` 自动批准受限工具集（无人监督必需） |
| `delegate_dsh` | `dsh` | `dsh --profile headless "<prompt>"` | 需已配置 headless profile |
| `delegate_omp` | `omp` | `omp -p --auto-approve "<prompt>"` | opencode / omp；`--auto-approve` 跳过批准提示 |
| `delegate_zcode` | `node zcode.cjs` | `zcode.cjs -p "<prompt>"` | 智谱 GLM 驱动；**需先配置 provider** |
| `delegate_workbuddy` | `node codebuddy` | `codebuddy -p "<prompt>"` | **需先 `/login`** 本机登录 |
| `delegate`（通用） | — | 传 `agent` 参数指定 | 一个工具覆盖全部 |

每个工具接受 `prompt`（必填）和可选 `cwd`（工作目录）。

### 关于 qoder

本机实测 `qoder` 的 `code.cmd` 是 **VSCode 系 IDE 启动器**（打开文件/文件夹），
不是"给 prompt 就改代码"的 AI agent，无法以非交互方式委派，故**未纳入**。
如果 Qoder 后续提供 headless CLI，可在 `index.js` 的 `AGENTS` 中按同格式添加。

## 前置要求

在把本桥接器接入 Codex 之前，目标机器需要满足：

1. **Node.js ≥ 18**（建议 ≥ 20）。用 `node --version` 确认。
2. **至少一个下游 agent CLI 可用**（见下表"如何获得入口"）。
3. 每个 agent 的**无人监督前置条件**（登录 / provider 配置 / profile）已就绪。

### 各 agent 的入口与非交互前置条件

| agent | 入口形式 | 无人监督前置条件 | 怎么获得 |
|---|---|---|---|
| `cline` | npm 全局 `cline`（`cline.cmd`） | 已 `cline auth` 登录；`-y` 由桥自动加 | `npm i -g cline` 后 `cline auth` |
| `dsh` | npm 全局 `dsh`（`dsh.cmd`） | 已配置 `headless` profile（`$DSH_HOME/profiles/headless`） | 见 DeepSeek Harness 文档 |
| `omp` | 原生 `omp.exe` | 无需额外登录（取决于后端 key） | 见 opencode/omp 安装页 |
| `zcode` | `node zcode.cjs`（桌面 app 内嵌） | **需配置 provider**（`zcode-builtin.json`），否则报"无法定位 Provider Config" | 定位 ZCode 安装目录下 `resources\glm\zcode.cjs` |
| `workbuddy` | `node codebuddy`（桌面 app 内嵌） | **需先 `/login`**，否则报 "Authentication required" | 定位 WorkBuddyAI 安装目录下 `resources\app.asar.unpacked\cli\bin\codebuddy` |

> **zcode / workbuddy 是桌面应用内嵌的 CLI**，没有独立的 npm 包。迁移时：
> 1. 在新机器装好对应的桌面 app（ZCode / WorkBuddyAI）；
> 2. 找到上面"怎么获得"列里的入口文件绝对路径；
> 3. 用环境变量 `ZCODE_BIN` / `WORKBUDDY_BIN` 指过去（见下方"环境变量覆盖"）。
>
> 未满足前置条件时，委派会**立即失败并回传具体报错**（不会静默挂住）：
> zcode → `无法定位 CLI ZCode Built-in Provider Config`；workbuddy → `Authentication required. Please use /login`。

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

## 验证桥是否可用

仓库自带 `smoke-test.mjs`：以 MCP 客户端身份走一遍 `initialize → tools/list → tools/call`，
并实际调用 `delegate_omp` 跑一句无害 prompt。依赖已装时直接：

```bash
node smoke-test.mjs
```

预期输出包含六工具清单、`[omp] exit=0` 和模型回传的一行文字。
（它默认打 omp；换别的 agent 可改 `smoke-test.mjs` 里的 `delegate_omp`。）

## 迁移到新设备

照下面顺序走，任何一步失败就地停下排查：

1. **装本仓库**：`git clone` 后 `cd codex-agent-bridge && npm install`。
2. **装 Node ≥ 18**（若无）：用 `node --version` 确认。
3. **准备至少一个下游 agent**（见上方"前置要求"）：
   - `cline`：`npm i -g cline`，然后 `cline auth` 登录。
   - `omp`：按 opencode/omp 官方页安装 `omp.exe`，确认 `omp` 在 PATH。
   - `zcode` / `workbuddy`：装好桌面 app，记下内嵌 CLI 的绝对路径，完成登录/provider 配置。
4. **改 Codex 配置**：在 `~/.codex/config.toml` 里把 `args` 指向**本机**的 `index.js` 绝对路径；
   若 agent 入口不在默认位置，用 `[mcp_servers.codex-agent-bridge.env]` 传入
   `CLINE_BIN` / `ZCODE_BIN` / `WORKBUDDY_BIN` 等。
5. **验证**：`node smoke-test.mjs` 通过后，重启 Codex，让它看到 `delegate*` 工具。

> ⚠️ **Windows + 科学上网工具的证书坑**：若你用了 Watt Toolkit（Steam++）等会改写
> `hosts`、用自签证书劫持 github.com 的加速工具，`git push` / `gh` 可能报
> `certificate signed by unknown authority`。解决办法是让 git/gh 信任它的根证书
> （`SSL_CERT_FILE` / `GIT_SSL_CAINFO` 指向导出的 CA PEM），而不是关闭加速——
> 校园网直连 GitHub 往往不通。此问题只影响推送，不影响本桥在本地运行。

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
