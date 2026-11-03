/* 开发用：启动 headless Edge，执行一段页面脚本，再截图。
   用法：node scripts/dev-cdp-shot.js <port> <hashRoute> <jsExpression> <outPng>
   例：node scripts/dev-cdp-shot.js 62664 "#/home" "doSearch('repro')" docs/ui-search.png */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9223;
const [, , appPort, route, expression, outPath] = process.argv;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const profile = path.join(os.tmpdir(), "zhanci-cdp");
  const child = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  let page = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      page = list.find((item) => item.type === "page");
      if (page) break;
    } catch {
      /* 还没起来 */
    }
  }
  if (!page) throw new Error("Edge CDP 没有启动");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: Number(process.env.SHOT_W || 1280),
    height: Number(process.env.SHOT_H || 860),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${appPort}/${route}` });
  await sleep(6500);

  if (expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("eval:", JSON.stringify(result.result?.result?.value ?? result.result?.exceptionDetails));
    await sleep(2200);
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const output = path.resolve(outPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(shot.result.data, "base64"));
  console.log("saved:", output, fs.statSync(output).size, "bytes");

  socket.close();
  child.kill();
}

main().catch((error) => {
  console.error("failed:", error.message);
  process.exit(1);
});