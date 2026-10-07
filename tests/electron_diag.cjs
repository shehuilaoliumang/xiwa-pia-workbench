// Electron 桌面版诊断：用 playwright 驱动真实 main.cjs，复现音视频播放与 AI 界面问题。
const { _electron } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const path = require("node:path");

const ROOT = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页";
const DATA_DIR = "C:\\Users\\Lu\\AppData\\Local\\Temp\\xiwa-ai-demo-16";
const MP3 = "C:\\Users\\Lu\\Music\\银临 - 不老梦_L.mp3";
const MP4 = "C:\\Users\\Lu\\Desktop\\爱情公寓.mp4";
const results = {};

(async () => {
  const electronApp = await _electron.launch({
    executablePath: path.join(ROOT, "desktop", "runtime", "electron.exe"),
    args: [path.join(ROOT, "desktop", "main.cjs"), "--url=http://127.0.0.1:8878/", "--data-dir=" + DATA_DIR, "--no-show"],
    cwd: ROOT,
  });
  const page = await electronApp.firstWindow();
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailed = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("requestfailed", (r) => requestFailed.push(r.url() + " :: " + ((r.failure() || {}).errorText || "")));

  async function record(name, fn) {
    try { results[name] = await fn(); console.log("PASS " + name); }
    catch (e) { results[name] = "ERR: " + e.message.split("\n")[0]; console.log("FAIL " + name + ": " + e.message.split("\n")[0]); }
  }

  await page.goto("http://127.0.0.1:8878/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // 1) 新建剧本 + 上传 mp3 + mp4
  await record("electron-open-new-script", async () => {
    await page.locator("#new-script").first().click();
    await page.waitForTimeout(800);
    return page.locator("#script-dialog").isVisible();
  });

  await record("electron-upload-mp3", async () => {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.locator("#add-media-block").first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(MP3);
    await page.waitForTimeout(3000);
    return await page.locator("#script-media-status").innerText();
  });

  await record("electron-upload-mp4", async () => {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.locator("#add-media-block").first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(MP4);
    await page.waitForTimeout(4000);
    return await page.locator("#script-media-status").innerText();
  });

  await record("electron-save-script", async () => {
    await page.locator("#edit-title").fill("Electron 诊断剧本");
    await page.locator("#script-form button[type=submit]").click();
    await page.waitForTimeout(1500);
    return await page.locator("#script-dialog").isVisible() === false;
  });

  let scriptId = null;
  await record("electron-find-script", async () => {
    const lib = await (await electronApp.evaluate(({ fetch }) => fetch("http://127.0.0.1:8878/api/library").then((r) => r.json()))).json();
    // electronApp.evaluate returns JSON-serializable? use request instead:
    throw new Error("placeholder");
  }).catch(() => {});

  // 用 page 直接请求
  const lib = await (await page.request.get("http://127.0.0.1:8878/api/library")).json();
  const s = lib.scripts.find((x) => x.title === "Electron 诊断剧本");
  if (s) scriptId = s.id;
  results["electron-script-id"] = scriptId;
  console.log("scriptId=" + scriptId);

  // 2) reader 页播放
  await record("electron-reader-play", async () => {
    await page.goto("http://127.0.0.1:8878/script/" + encodeURIComponent(scriptId), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const card = page.locator(".audio-block .media-card").first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    await card.click();
    await page.waitForTimeout(2000);
    const audio = await page.evaluate(() => {
      const p = document.querySelector(".audio-block audio, .audio-block video");
      if (!p) return { found: false };
      return { found: true, tag: p.tagName, src: p.currentSrc || p.src, readyState: p.readyState, networkState: p.networkState, paused: p.paused, error: p.error ? String(p.error.code) : null, currentTime: p.currentTime, duration: p.duration };
    });
    const card2 = page.locator(".video-block .media-card").first();
    await card2.click();
    await page.waitForTimeout(2500);
    const video = await page.evaluate(() => {
      const p = document.querySelector(".video-block video");
      if (!p) return { found: false };
      return { found: true, src: p.currentSrc || p.src, readyState: p.readyState, networkState: p.networkState, paused: p.paused, error: p.error ? String(p.error.code) : null, currentTime: p.currentTime, duration: p.duration };
    });
    return { audio, video };
  });

  // 3) manage AI 设置对话框
  await record("electron-ai-settings", async () => {
    await page.goto("http://127.0.0.1:8878/manage", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.locator("#tab-ai").first().click();
    await page.waitForTimeout(500);
    await page.locator("#open-ai-settings").first().click();
    await page.waitForTimeout(1000);
    const visible = await page.locator("#ai-settings-dialog").isVisible();
    return { visible, pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
  });

  // 4) media_editor AI 生成弹层
  await record("electron-media-ai-dialog", async () => {
    await page.goto("http://127.0.0.1:8878/script/" + encodeURIComponent(scriptId) + "/media", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.locator("#media-ai-generate").first().click();
    await page.waitForTimeout(1200);
    const visible = await page.locator("#ai-video-dialog").isVisible();
    return { visible, pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
  });

  console.log("PAGE_ERRORS: " + JSON.stringify(pageErrors));
  console.log("CONSOLE_ERRORS: " + JSON.stringify(consoleErrors));
  console.log("REQUEST_FAILED: " + JSON.stringify(requestFailed));
  console.log("RESULT " + JSON.stringify(results, null, 2));
  await electronApp.close();
})().catch((e) => { console.error("FATAL " + e); process.exit(2); });
