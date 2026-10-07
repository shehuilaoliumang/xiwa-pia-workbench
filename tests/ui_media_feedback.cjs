// 验证：AI 队列清除 + 配本页媒体卡片点击播放
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const out = [];
(async () => {
  // 0) 拿 CSRF + 提交一个 mock 视频任务（成功态）
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const task = await (await fetch(BASE + "/api/ai/video/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ prompt: "清除队列验证", platform: "mock", model: "", ratio: "9:16", duration: 5, script_id: SCRIPT, block_id: "block-7763c3e9b2e44432a7fe9c5bbc475933", role_name: "", ref_image: null }),
  })).json();
  let cur = task;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 700));
    cur = await (await fetch(BASE + "/api/ai/tasks/" + task.task_id)).json();
    if (["succeeded", "failed"].includes(cur.status)) break;
  }
  out.push("mock 任务完成: " + cur.status);

  // 1) 清除已完成任务
  const del = await (await fetch(BASE + "/api/ai/tasks/finished", { method: "DELETE", headers: { "X-CSRF-Token": token } })).json();
  out.push("清除接口返回: deleted=" + del.deleted);
  const after = await (await fetch(BASE + "/api/ai/tasks?limit=50")).json();
  const gone = !after.tasks.some((t) => t.task_id === task.task_id);
  out.push("清除后任务已不存在: " + gone);

  // 2) 配本页：媒体卡片显示「点击播放」+ 点击展开播放器
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const mediaInfo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    return cards.map((c) => c.textContent.replace(/\s+/g, " ").slice(0, 50));
  });
  out.push("段落媒体卡片: " + JSON.stringify(mediaInfo));
  // 点击第一个视频卡片
  const firstVideo = await page.evaluate(() => {
    const c = document.querySelector("#media-block-choices .media-block-media.is-video");
    if (!c) return null;
    c.click();
    return true;
  });
  await page.waitForTimeout(2500);
  const playerInfo = await page.evaluate(() => {
    const wrap = document.querySelector("#media-block-choices .media-block-player-wrap:not([hidden])");
    if (!wrap) return { opened: false };
    const v = wrap.querySelector("video");
    return { opened: true, tag: v ? "video" : "audio", readyState: v ? v.readyState : 0, src: (v || wrap.querySelector("audio")).src.slice(-30) };
  });
  out.push("点击后展开: " + JSON.stringify(playerInfo));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\20-配本页媒体播放预载.png" });
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
