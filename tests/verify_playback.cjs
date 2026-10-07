// 端到端播放验收：播控台播放爱情公寓配本视频 + 音视频配本页稳定 + reader 页面
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8878";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // 1) 播控台：找到爱情公寓剧本并播放配本视频
  console.log("== control page ==");
  await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const ctlState = await page.evaluate(() => {
    const out = {};
    out.title = document.querySelector(".control-script-title, h1, #control-title")?.textContent || "";
    out.mediaKind = document.querySelector("#control-media, .control-media, video, audio")?.tagName || "none";
    const media = document.querySelector("#control-media, .control-media, video, audio");
    if (media) {
      out.src = media.src;
      out.preload = media.preload;
    }
    return out;
  });
  console.log("CTL " + JSON.stringify(ctlState));

  // 尝试切换/选中爱情公寓剧本（如果播控台默认不是它）
  const inCtl = await page.evaluate(() => document.body.innerText.includes("爱情公寓"));
  console.log("ctl-has-爱情公寓: " + inCtl);

  // 2) 音视频配本页：爱情公寓剧本
  console.log("== media editor page ==");
  const lib = await (await context.request.get(BASE + "/api/library")).json();
  const love = lib.scripts.find((s) => s.title === "爱情公寓") || lib.scripts.find((s) => s.media);
  console.log("target: " + JSON.stringify({ id: love.id, title: love.title, media: love.media && { path: love.media.path, kind: love.media.kind, cues: (love.media.cues || []).length } }));
  await page.goto(BASE + "/script/" + encodeURIComponent(love.id) + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const me = await page.evaluate(() => {
    const player = document.querySelector("#media-player");
    const out = { state: document.querySelector("#media-save-state")?.textContent || "", err: document.querySelector("#media-editor-error")?.textContent || "" };
    if (player) { out.tag = player.tagName; out.src = player.src; out.preload = player.preload; }
    return out;
  });
  console.log("MEDIA-EDITOR " + JSON.stringify(me));

  // 3) 点击播放按钮尝试播放（video）
  const playResult = await page.evaluate(async () => {
    const player = document.querySelector("#media-player");
    if (!player) return { ok: false, why: "no-player" };
    const before = player.readyState;
    try { await player.play(); } catch (e) { return { ok: false, why: String(e).split("\n")[0], readyState: player.readyState }; }
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, readyState: player.readyState, currentTime: player.currentTime, duration: player.duration, networkState: player.networkState };
  });
  console.log("PLAY " + JSON.stringify(playResult));

  // 4) 闪动检测：连续采样配本页布局是否稳定（无反复重绘）
  const flicker = await page.evaluate(async () => {
    const before = document.querySelector("#media-player-wrap")?.innerHTML.length || 0;
    let changes = 0;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const now = document.querySelector("#media-player-wrap")?.innerHTML.length || 0;
      if (now !== before) changes++;
    }
    return { changes, stable: changes === 0 };
  });
  console.log("FLICKER " + JSON.stringify(flicker));

  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\04-恢复后-配本页播放.png" });
  console.log("PAGE_ERRORS " + JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL " + e); process.exit(2); });
