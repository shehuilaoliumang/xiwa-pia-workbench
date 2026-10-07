// 诊断：①正文音视频上传后播放 ②AI 生成界面闪退。使用独立 8879 实例，不碰 16 篇库。
const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = "http://127.0.0.1:8879";
const MP3 = "C:\\Users\\Lu\\Music\\银临 - 不老梦_L.mp3";
const MP4 = "C:\\Users\\Lu\\Desktop\\爱情公寓.mp4";
const results = {};

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailed = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("requestfailed", (r) => requestFailed.push(r.url() + " :: " + (r.failure() || {}).errorText));

  async function record(name, fn) {
    try { results[name] = await fn(); console.log("PASS " + name); }
    catch (e) { results[name] = "ERR: " + e.message.split("\n")[0]; console.log("FAIL " + name + ": " + e.message.split("\n")[0]); }
  }

  // 1) 打开管理页 → 新建剧本
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await record("manage-load", async () => page.locator("#script-dialog").count() >= 0 && true);

  // 新建剧本
  await record("open-new-script", async () => {
    await page.locator("#new-script").first().click();
    await page.waitForTimeout(600);
    return page.locator("#script-dialog").isVisible();
  });

  // 上传 MP3：点「＋ 添加音视频」尾部按钮触发 file chooser
  await record("upload-mp3", async () => {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.locator("#add-media-block").first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(MP3);
    await page.waitForTimeout(3000);
    const status = await page.locator("#script-media-status").innerText();
    return status;
  });

  // 再上传 MP4
  await record("upload-mp4", async () => {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.locator("#add-media-block").first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(MP4);
    await page.waitForTimeout(4000);
    const status = await page.locator("#script-media-status").innerText();
    return status;
  });

  // 保存剧本
  await record("save-script", async () => {
    await page.locator("#edit-title").fill("音视频播放诊断剧本");
    await page.locator("#script-form button[type=submit]").click();
    await page.waitForTimeout(1500);
    return await page.locator("#script-dialog").isVisible() === false;
  });

  // 拿到剧本 id
  let scriptId = null;
  await record("find-script-id", async () => {
    const lib = await (await context.request.get(BASE + "/api/library")).json();
    const s = lib.scripts.find((x) => x.title === "音视频播放诊断剧本");
    if (!s) throw new Error("剧本未找到");
    scriptId = s.id;
    const mediaBlocks = (s.blocks || []).filter((b) => b.kind === "video" || b.kind === "audio");
    return { scriptId: s.id, blocks: (s.blocks || []).map((b) => b.kind), mediaBlocks: mediaBlocks.map((b) => ({ kind: b.kind, path: b.media_path, name: b.media_name })) };
  });

  // 2) reader 页播放测试
  await record("reader-play-audio", async () => {
    await page.goto(BASE + "/script/" + encodeURIComponent(scriptId), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const card = page.locator(".audio-block .media-card").first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    await card.click();
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      const p = document.querySelector(".audio-block video, .audio-block audio");
      if (!p) return { found: false };
      return { found: true, tag: p.tagName, src: p.currentSrc || p.src, readyState: p.readyState, networkState: p.networkState, paused: p.paused, error: p.error ? String(p.error.code) : null, duration: p.duration, currentTime: p.currentTime };
    });
    return state;
  });

  await record("reader-play-video", async () => {
    const card = page.locator(".video-block .media-card").first();
    if (!(await card.count())) return { found: false, msg: "无视频卡（可能上传失败）" };
    await card.click();
    await page.waitForTimeout(2000);
    const state = await page.evaluate(() => {
      const p = document.querySelector(".video-block video");
      if (!p) return { found: false };
      return { found: true, src: p.currentSrc || p.src, readyState: p.readyState, networkState: p.networkState, paused: p.paused, error: p.error ? String(p.error.code) : null, videoWidth: p.videoWidth, videoHeight: p.videoHeight, currentTime: p.currentTime };
    });
    return state;
  });

  // 3) media_editor 页 AI 生成弹层（闪退复现）
  await record("media-editor-ai-dialog", async () => {
    await page.goto(BASE + "/script/" + encodeURIComponent(scriptId) + "/media", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.locator("#media-ai-generate").first().click();
    await page.waitForTimeout(1500);
    const visible = await page.locator("#ai-video-dialog").isVisible();
    return { visible, pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
  });

  // 4) manage 页 AI 设置对话框
  await record("manage-ai-settings-dialog", async () => {
    await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const tab = page.locator("#tab-ai").first();
    await tab.click();
    await page.waitForTimeout(400);
    await page.locator("#open-ai-settings").first().click();
    await page.waitForTimeout(800);
    const visible = await page.locator("#ai-settings-dialog").isVisible();
    return { visible, pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
  });

  // 5) 角色库对话框
  await record("manage-characters-dialog", async () => {
    await page.locator("#ai-settings-dialog [data-ai-settings-close], #ai-settings-dialog .icon-button").first().click();
    await page.waitForTimeout(300);
    await page.locator("#open-ai-characters").first().click();
    await page.waitForTimeout(800);
    const visible = await page.locator("#ai-characters-dialog").isVisible();
    return { visible, pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
  });

  // 6) 直接请求媒体资源，验证可达性
  await record("media-url-reachable", async () => {
    const lib = await (await context.request.get(BASE + "/api/library")).json();
    const s = lib.scripts.find((x) => x.id === scriptId);
    const blocks = (s.blocks || []).filter((b) => b.kind === "video" || b.kind === "audio");
    const out = [];
    for (const b of blocks) {
      const r = await context.request.get(BASE + b.media_path);
      out.push({ path: b.media_path, status: r.status(), contentType: r.headers()["content-type"] || "", size: (r.headers()["content-length"] || "") });
    }
    return out;
  });

  console.log("PAGE_ERRORS: " + JSON.stringify(pageErrors));
  console.log("CONSOLE_ERRORS: " + JSON.stringify(consoleErrors));
  console.log("REQUEST_FAILED: " + JSON.stringify(requestFailed));
  console.log("RESULT " + JSON.stringify(results, null, 2));
  await browser.close();
})().catch((e) => { console.error("FATAL " + e); process.exit(2); });
