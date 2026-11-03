/* 开发用：连一个已经在跑的实例，批量重截 README 用的界面图。
   用法：node scripts/capture-docs.js <port> <key1,key2,...>
   例：node scripts/capture-docs.js 51214 home,today,bank */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9224;
const [, , appPort, keysArg] = process.argv;
const KEYS = (keysArg || "").split(",").map((key) => key.trim()).filter(Boolean);
const OUT = path.resolve("docs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 每张图：切到哪个路由、切过去之后跑什么、等多久
const SHOTS = {
  home: { route: "#/home", wait: 1100 },
  today: { route: "#/today", wait: 1200 },
  bank: { route: "#/bank", wait: 1400 },
  study: { route: "#/study", wait: 2400 },
  review: { route: "#/review", wait: 2200 },
  notes: { route: "#/notes", wait: 1400 },
  affix: { route: "#/affix", wait: 1500 },
  "affix-words": { route: "#/affix/prefix/un", wait: 1600 },
  stats: { route: "#/stats", wait: 2000 },
  lookup: { route: "#/lookup/harbinger", wait: 1800 },
  search: {
    route: "#/home",
    expr: `(()=>{const i=document.querySelector('#global-search');i.focus();i.value='repro';i.dispatchEvent(new Event('input',{bubbles:true}));return 'searched';})()`,
    wait: 1800,
  },
  batch: {
    route: "#/bank",
    expr: `(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));document.querySelector('[data-action=enter-select]').click();await s(400);for(let i=0;i<3;i++){[...document.querySelectorAll('.word-check')][i]?.click();await s(280);}return 'selected';})()`,
    wait: 1200,
  },
  "review-status": {
    route: "#/bank",
    expr: `(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));const q=await fetch('/api/v1/review/queue?size=1').then(r=>r.json());const w=q.data.words[0].headword;const input=document.querySelector('.bank-toolbar input');input.value=w;input.dispatchEvent(new Event('input',{bubbles:true}));await s(1500);document.querySelector('.word-row').click();await s(1500);return w+' -> '+(document.querySelector('.detail-review .link-btn')?'ok':'none');})()`,
    wait: 1200,
  },
  "notes-panel": {
    route: "#/bank",
    expr: `(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));document.querySelector('.word-row').click();await s(1200);document.querySelector('[data-action=open-notes]')?.click();await s(1200);return 'notes open';})()`,
    wait: 1200,
  },
  "import-history": {
    route: "#/home",
    expr: `(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));document.querySelector('#btn-settings').click();await s(1600);document.querySelector('.settings-group:nth-of-type(3)')?.scrollIntoView({block:'center'});await s(400);return 'settings';})()`,
    wait: 1200,
  },
};

async function main() {
  const missing = KEYS.filter((key) => !SHOTS[key]);
  if (missing.length) throw new Error(`未知的截图 key：${missing.join(",")}`);

  const profile = path.join(os.tmpdir(), "engpilot-cdp");
  const child = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  let page = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
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
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result?.result?.value;
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${appPort}/#/home` });
  await sleep(6000);

  let current = "#/home";
  for (const key of KEYS) {
    const shot = SHOTS[key];
    // 清掉上一张留下的弹层和多选状态
    await evaluate(`(()=>{document.getElementById('modal-root').innerHTML='';const b=document.querySelector('[data-action=exit-select]');if(b)b.click();return 'clean';})()`);
    if (shot.route === current) {
      await evaluate(`location.hash='#/today'`);
      await sleep(500);
    }
    await evaluate(`location.hash='${shot.route}'`);
    current = shot.route;
    await sleep(shot.wait);

    if (shot.expr) {
      const value = await evaluate(shot.expr);
      if (value !== undefined) console.log(`  ${key}: ${JSON.stringify(value)}`);
      await sleep(shot.wait);
    }

    const image = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, `ui-${key}.png`), Buffer.from(image.result.data, "base64"));
    console.log(`saved docs/ui-${key}.png`);
  }

  socket.close();
  child.kill();
}

main().catch((error) => {
  console.error("failed:", error.message);
  process.exit(1);
});