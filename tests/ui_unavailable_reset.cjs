// 验证：重置未开通记录 → 恢复全部模型显示
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  await p.click("#tab-ai");
  await p.waitForTimeout(500);
  // 打开设置 → 点重置
  await p.click("#open-ai-settings");
  await p.waitForTimeout(1200);
  await p.click("#ai-unavailable-reset");
  await p.waitForTimeout(1000);
  const resetMsg = await p.evaluate(() => {
    const e = document.getElementById("ai-settings-error");
    return { hidden: e.hidden, text: e.textContent };
  });
  out.push("重置反馈: " + JSON.stringify(resetMsg));
  // 重置后关闭设置，打开角色库验证字节图像下拉恢复
  await p.evaluate(() => { document.querySelector("[data-ai-settings-close]").click(); });
  await p.waitForTimeout(400);
  await p.click("#open-ai-characters");
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-platform");
    sel.value = "byte";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(400);
  const img = await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-model");
    return { count: sel.options.length, all: [...sel.options].map((o) => o.value), selected: sel.value };
  });
  out.push("重置后角色图字节下拉: " + JSON.stringify(img));
  // 截图设置弹窗（含重置按钮）
  await p.evaluate(() => { document.querySelector("[data-ai-characters-close]").click(); });
  await p.waitForTimeout(300);
  await p.click("#open-ai-settings");
  await p.waitForTimeout(1000);
  const box = await p.evaluate(() => {
    const d = document.getElementById("ai-settings-dialog");
    const r = d.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await p.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\27-重置未开通记录.png", clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: Math.min(1440, box.w + 40), height: Math.min(900, box.h + 40) } });
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
