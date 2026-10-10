// 冒烟测试：以 MCP 客户端身份连上 stdio server，走 initialize -> tools/list -> tools/call
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn("node", [path.join(here, "index.js")], {
  cwd: here,
  stdio: ["pipe", "pipe", "inherit"],
});

server.on("error", (e) => {
  console.error("SERVER SPAWN ERROR:", e);
  process.exit(3);
});

const rl = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const timeout = setTimeout(() => {
  console.error("TEST TIMEOUT");
  server.kill();
  process.exit(2);
}, 90000);

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  console.log("=== initialize ===");
  console.log("serverInfo:", JSON.stringify(init.result?.serverInfo));

  notify("notifications/initialized", {});

  const list = await send("tools/list", {});
  console.log("=== tools/list ===");
  console.log(list.result?.tools?.map((t) => t.name).join(", "));

  console.log("=== tools/call delegate_omp ===");
  const call = await send("tools/call", {
    name: "delegate_omp",
    arguments: { prompt: "Reply with exactly: BRIDGE_OK", cwd: here },
  });
  const text = call.result?.content?.[0]?.text || "(no text)";
  console.log(text.slice(0, 2000));

  console.log("=== unknown agent guard ===");
  const bad = await send("tools/call", {
    name: "delegate",
    arguments: { agent: "qoder", prompt: "hi" },
  });
  console.log("isError:", bad.result?.isError, "|", bad.result?.content?.[0]?.text);

  clearTimeout(timeout);
  server.stdin.end();
  server.on("close", () => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
} catch (e) {
  console.error("TEST ERROR:", e);
  clearTimeout(timeout);
  server.kill();
  setTimeout(() => process.exit(1), 500);
}

