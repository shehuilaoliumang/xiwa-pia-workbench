// UI 全流程：音视频配本页 本地文件 → 插入正文段落
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-04c7323f09b4"; // 临时剧本
const MP3 = "C:\\Users\\Lu\\Music\\银临 - 不老梦_L.mp3";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);

  // 1) 选择文件 → 去向 UI 应显示
  await page.setInputFiles("#media-upload-file", MP3);
  await page.waitForTimeout(600);
  const dest = await page.evaluate(() => ({
    destVisible: !document.getElementById("media-upload-dest").hidden,
    uploadBtn: document.getElementById("media-upload").textContent,
    options: [...document.querySelectorAll("#media-block-target option")].map((o) => o.textContent.slice(0, 18)),
  }));
  console.log("选文件后:", JSON.stringify(dest));

  // 2) 切换去向 = 插入到正文段落
  await page.check('input[name="media-dest"][value="block"]');
  await page.waitForTimeout(400);
  const afterSwitch = await page.evaluate(() => ({
    targetVisible: !document.getElementById("media-block-target-wrap").hidden,
    uploadBtn: document.getElementById("media-upload").textContent,
    status: document.getElementById("media-upload-status").textContent,
  }));
  console.log("切换去向:", JSON.stringify(afterSwitch));

  // 3) 选目标段落：第一段后
  await page.selectOption("#media-block-target", { index: 1 }); // index0=追加末尾, index1=第1段
  await page.click("#media-upload");
  await page.waitForTimeout(2500);

  // 4) 验证结果
  const result = await page.evaluate(() => ({
    status: document.getElementById("media-upload-status").textContent,
    error: document.getElementById("media-editor-error").textContent,
    errorHidden: document.getElementById("media-editor-error").hidden,
  }));
  console.log("插入结果:", JSON.stringify(result));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\14-配本页-插入正文.png" });

  // 5) 数据层验证
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const script = lib.scripts.find((s) => s.id === SCRIPT);
  const seq = script.blocks.map((b) => (b.kind === "text" ? "text:" + (b.text || "").slice(0, 4) : b.kind + ":" + (b.media_name || "").slice(0, 10)));
  console.log("最终段落序列:", JSON.stringify(seq));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
