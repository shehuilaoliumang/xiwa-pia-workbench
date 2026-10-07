// 轮询已触发的 3-0-t2i 任务 → 验证不可用自动记录 + 前端隐藏
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) 从任务列表找 byte 图像任务
  let taskId = "task_beffd90a5299e271";
  let terminal = null;
  for (let i = 0; i < 50; i++) {
    await sleep(3000);
    const t = await (await fetch("http://127.0.0.1:8765/api/ai/tasks/" + taskId, { cache: "no-store" })).json();
    if (t && (t.status === "succeeded" || t.status === "failed")) {
      terminal = { status: t.status, error: t.error_message || t.message || "", file: t.result_file || "" };
      break;
    }
  }
  out.push("终态: " + JSON.stringify(terminal));
  // 2) status 看 unavailable / image_model
  const st = await (await fetch("http://127.0.0.1:8765/api/ai/status", { cache: "no-store" })).json();
  out.push("字节 unavailable: " + JSON.stringify((st.platforms.byte || {}).unavailable_models));
  out.push("字节 image_model: " + JSON.stringify((st.platforms.byte || {}).image_model));
  // 3) 前端验证下拉
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  await p.click("#tab-ai");
  await p.waitForTimeout(500);
  await p.click("#open-ai-characters");
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-platform");
    sel.value = "byte";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(400);
  const selState = await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-model");
    return { count: sel.options.length, all: [...sel.options].map((o) => o.value), selected: sel.value };
  });
  out.push("前端字节下拉: " + JSON.stringify(selState));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
