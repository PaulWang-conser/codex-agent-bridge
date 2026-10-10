#!/usr/bin/env node
/**
 * codex-agent-bridge
 *
 * 让 Codex（GPT 大脑做计划）通过 MCP 把执行任务委派给本地 AI CLI：
 *   cline / dsh / omp / zcode / workbuddy
 *
 * 每个工具以“无人监督 / 非交互”方式 spawn 对应 CLI，捕获输出回传给 Codex。
 * 协议消息一律写 stdout，日志一律写 stderr。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";

const TIMEOUT_MS = Number(process.env.DELEGATE_TIMEOUT_MS || 600000); // 默认 10 分钟
const MAX_OUT = Number(process.env.DELEGATE_MAX_OUT || 30000); // 回传截断长度

// ---------------------------------------------------------------------------
// agent 注册表
//
// mode 决定 spawn 方式：
//   "shell"       -> spawn(cmd, quotedArgs, { shell: true })   用于 npm .cmd shim
//   "direct"      -> spawn(cmd, args,      { shell: false })   用于原生 .exe
//   "node-script" -> spawn(node, [script, ...args])            用于 node cli.cjs
//
// command() 解析顺序：环境变量覆盖 -> 本机默认绝对路径 / PATH 名。
// 换机器时用环境变量（CLINE_BIN / DSH_BIN / OMP_BIN / ZCODE_BIN / WORKBUDDY_BIN）指向入口。
// ---------------------------------------------------------------------------
const AGENTS = {
  cline: {
    desc: "Cline CLI（-y 无人监督：自动批准一组受限工具）",
    command: () => process.env.CLINE_BIN || "cline",
    mode: "shell",
    // -y/--yolo：auto-approve 一组受限工具，实现非交互执行。
    // 不加 -y 时，cline 会停在“是否批准工具调用”的交互确认上，
    // 在无 TTY 的委派环境里会挂住直到超时。
    args: (prompt) => ["-y", prompt],
  },
  dsh: {
    desc: "DeepSeek Harness（headless profile，答一题即退出；需已配置 headless profile）",
    command: () => process.env.DSH_BIN || "dsh",
    mode: "shell",
    args: (prompt) => ["--profile", "headless", prompt],
  },
  omp: {
    desc: "opencode / omp（-p 非交互 + --auto-approve 跳过批准）",
    command: () => process.env.OMP_BIN || "omp",
    mode: "direct",
    // -p/--print：非交互模式，处理完 prompt 即退出。
    // --auto-approve：跳过工具批准提示，否则会卡在交互确认上。
    args: (prompt) => ["-p", "--auto-approve", prompt],
  },
  zcode: {
    desc: "ZCode CLI（-p 单次 prompt）",
    command: () =>
      process.env.ZCODE_BIN ||
      "D:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
    mode: "node-script",
    args: (prompt) => ["-p", prompt],
  },
  workbuddy: {
    desc: "WorkBuddy / codebuddy CLI（-p 单次 prompt，需先在本机登录）",
    command: () =>
      process.env.WORKBUDDY_BIN ||
      "D:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    mode: "node-script",
    args: (prompt) => ["-p", prompt],
  },
};

function quoteForCmd(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
  } catch {
    /* 忽略 */
  }
}

function runAgent(name, prompt, cwd) {
  const agent = AGENTS[name];
  const logicalArgs = agent.args(prompt);
  let file;
  let finalArgs;
  let useShell;

  if (agent.mode === "node-script") {
    file = process.execPath; // 当前 node
    finalArgs = [agent.command(), ...logicalArgs];
    useShell = false;
  } else if (agent.mode === "direct") {
    file = agent.command();
    finalArgs = logicalArgs;
    useShell = false;
  } else {
    file = agent.command();
    finalArgs = logicalArgs.map(quoteForCmd);
    useShell = true;
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, finalArgs, {
        shell: useShell,
        cwd: cwd || process.cwd(),
        windowsHide: true,
        // stdin 用 ignore（非 pipe）：避免部分 CLI（如 omp）检测到 stdin 是管道时
        // 切换成"从 stdin 读 prompt 并等 EOF"的模式而忽略命令行 prompt 参数。
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e.message || e), killed: false });
      return;
    }

    let out = "";
    let err = "";
    let killed = false;
    let done = false;

    const timer = setTimeout(() => {
      killed = true;
      killTree(child.pid);
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err, killed });
    };
    child.on("error", (e) => {
      err += "\n" + String(e.message || e);
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

function truncate(s) {
  if (s.length <= MAX_OUT) return s;
  return s.slice(0, MAX_OUT) + `\n...[truncated ${s.length - MAX_OUT} chars]`;
}

function formatResult(name, r) {
  const head = `[${name}] exit=${r.code}${r.killed ? " (timeout/killed)" : ""}`;
  let body = "";
  if (r.out && r.out.trim()) body += r.out;
  if (r.err && r.err.trim()) body += (body ? "\n--- stderr ---\n" : "") + r.err;
  return head + "\n" + truncate(body || "(no output)");
}


// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "codex-agent-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const promptProp = {
  type: "string",
  description: "要交给下游 agent 执行的任务描述（prompt）",
};
const cwdProp = {
  type: "string",
  description: "工作目录（可选，默认当前目录）",
};

const tools = [];

// 通用 delegate 工具
tools.push({
  name: "delegate",
  description:
    "把任务委派给指定的本地 AI CLI 执行。agent 可选：" +
    Object.keys(AGENTS).join(", "),
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: Object.keys(AGENTS),
        description: "目标 agent",
      },
      prompt: promptProp,
      cwd: cwdProp,
    },
    required: ["agent", "prompt"],
  },
});

// 每个 agent 一个便捷工具
for (const [name, a] of Object.entries(AGENTS)) {
  tools.push({
    name: `delegate_${name}`,
    description: `把任务委派给 ${name} 执行。${a.desc}`,
    inputSchema: {
      type: "object",
      properties: { prompt: promptProp, cwd: cwdProp },
      required: ["prompt"],
    },
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let agent;
  let prompt;
  let cwd;

  if (name === "delegate") {
    agent = args?.agent;
    prompt = args?.prompt;
    cwd = args?.cwd;
  } else if (name.startsWith("delegate_")) {
    agent = name.slice("delegate_".length);
    prompt = args?.prompt;
    cwd = args?.cwd;
  }

  if (!agent || !AGENTS[agent]) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `未知 agent: ${agent}。可用：${Object.keys(AGENTS).join(", ")}`,
        },
      ],
    };
  }
  if (!prompt || !String(prompt).trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少 prompt 参数。" }],
    };
  }

  try {
    const r = await runAgent(agent, String(prompt), cwd);
    return { content: [{ type: "text", text: formatResult(agent, r) }] };
  } catch (e) {
    return {
      isError: true,
      content: [
        { type: "text", text: `delegate_${agent} 失败：${e.message || e}` },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[codex-agent-bridge] MCP server 已启动（stdio）");
