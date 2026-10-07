// 验证：AI 中心队列浮层 + 角色图任务反馈准确性
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // 1) 切到 AI tab → 浮层出现
  await page.click("#tab-ai");
  await page.waitForTimeout(1200);
  const floatVisible = await page.evaluate(() => {
    const f = document.getElementById("ai-task-float");
    return { hidden: f.hidden, visible: !f.hidden };
  });
  out.push("AI tab 队列浮层显示: " + JSON.stringify(floatVisible));

  // 2) 打开角色库 → 选角色 → mock 生成形象图
  await page.click("#open-ai-characters");
  await page.waitForTimeout(800);
  const genState = await page.evaluate(() => {
    const list = document.querySelector("#ai-characters-list");
    const first = list && list.querySelector(".ai-character-row");
    if (first) { first.click(); return { hasRole: true }; }
    return { hasRole: false };
  });
  out.push("角色库: " + JSON.stringify(genState));
  if (genState.hasRole) {
    await page.evaluate(() => {
      const platform = document.getElementById("ai-character-image-platform");
      platform.value = "mock";
    });
    await page.click("#ai-character-generate");
    await page.waitForTimeout(1500);
    // 3) 浮层应显示形象图任务
    const taskInFloat = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#ai-task-float-body .ai-task-item")];
      return items.map((i) => i.textContent.replace(/\s+/g, " ").slice(0, 60));
    });
    out.push("浮层任务: " + JSON.stringify(taskInFloat));
    // 4) 等待任务完成 → 状态反馈
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#ai-task-float-body .ai-task-item")];
      const status = document.getElementById("ai-character-status");
      return {
        tasks: items.map((i) => i.textContent.replace(/\s+/g, " ").slice(0, 60)),
        statusText: status ? status.textContent : "",
      };
    });
    out.push("完成后: " + JSON.stringify(after));
    await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\21-AI中心队列与角色图反馈.png" });
  }
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });
