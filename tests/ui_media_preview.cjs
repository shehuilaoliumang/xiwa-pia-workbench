// 验证：视频段落首帧画面预览 + 音频段落点击播放
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const out = [];
(async () => {
  // 0) 上传银临 mp3 为段落级音频（插到第 4 段后）
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const mp3 = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media\\89d66f958f5c0b6c4022c0b8fcd85f7e92e54ef60c2ec91cd61b18d17e613fd1.mp3";
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(mp3)], { type: "audio/mpeg" }), "银临-不老梦_L.mp3");
  form.append("after_block_id", "block-058a8c5242984ba8a3fa29988a8260fd"); // 第 4 段后
  const up = await fetch(BASE + "/api/scripts/" + SCRIPT + "/blocks/media", {
    method: "POST", headers: { "X-CSRF-Token": token }, body: form,
  });
  const upJson = await up.json();
  out.push("插入音频段落: " + up.status + " " + JSON.stringify(upJson.error || "ok").slice(0, 60));

  // 1) 配本页验证
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const videoState = await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll("#media-block-choices .media-block-thumb")];
    return {
      thumbCount: thumbs.length,
      readyStates: thumbs.map((v) => v.readyState),
      times: thumbs.map((v) => v.currentTime.toFixed(2)),
    };
  });
  out.push("视频缩略图: " + JSON.stringify(videoState));

  // 2) 点击音频卡片 → 播放器展开
  const audioState = await page.evaluate(() => {
    const card = [...document.querySelectorAll("#media-block-choices .media-block-media")].find((c) => c.textContent.includes("银临"));
    if (!card) return { found: false };
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { found: true };
  });
  await page.waitForTimeout(1500);
  const audioAfter = await page.evaluate(() => {
    const wrap = document.querySelector("#media-block-choices .media-block-player-wrap:not([hidden])");
    const a = wrap && wrap.querySelector("audio");
    return { opened: Boolean(wrap), audio: Boolean(a), readyState: a ? a.readyState : -1, preload: a ? a.preload : "" };
  });
  out.push("音频点击展开: " + JSON.stringify(audioAfter));

  // 截图（滚动到媒体卡片）
  await page.evaluate(() => {
    const c = document.querySelector("#media-block-choices .media-block-thumb");
    if (c) c.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\23-段落画面预览与音频.png" });
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });
