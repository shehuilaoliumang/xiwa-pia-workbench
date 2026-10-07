// 验证：设置弹窗 AK/SK 字段 + 测试按钮 + 引导；重试按钮不再竖排
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
  // 1) 设置弹窗字段检查
  await p.click("#open-ai-settings");
  await p.waitForTimeout(1200);
  const fields = await p.evaluate(() => {
    const ak = document.getElementById("ai-byte-ak");
    const sk = document.getElementById("ai-byte-sk");
    const act = document.getElementById("ai-byte-act-test");
    const guide = document.querySelector(".ai-key-guide summary");
    const akLabel = ak && ak.closest("label") && ak.closest("label").textContent.trim();
    return {
      hasAk: !!ak, hasSk: !!sk, hasActBtn: !!act,
      akLabel: akLabel,
      skPlaceholder: sk && sk.placeholder,
      guideText: guide && guide.textContent,
      actBtnText: act && act.textContent.trim(),
      statusText: document.getElementById("ai-byte-test-status").textContent,
    };
  });
  out.push("设置弹窗字段: " + JSON.stringify(fields));
  // 2) 无 AK/SK 时模型列表兼容（字节视频应有 8 个——2-0-260128 被实测隐藏）
  const videoState = await p.evaluate(() => {
    const sel = document.getElementById("ai-byte-model");
    return { count: sel.options.length, all: [...sel.options].map((o) => o.value) };
  });
  out.push("无AK/SK字节视频下拉: " + JSON.stringify(videoState));
  // 3) 截图设置弹窗
  const box = await p.evaluate(() => {
    const d = document.getElementById("ai-settings-dialog");
    const r = d.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await p.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\29-AKSK设置与测试按钮.png", clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: Math.min(1440, box.w + 40), height: Math.min(900, box.h + 40) } });
  // 4) 关闭设置，验证重试按钮样式（构造一个失败任务卡片）
  await p.evaluate(() => { document.querySelector("[data-ai-settings-close]").click(); });
  await p.waitForTimeout(400);
  const retryStyle = await p.evaluate(() => {
    // 直接检查 CSS 规则是否生效
    const rule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch (_) { return []; } })
      .find((r) => r.selectorText && r.selectorText.includes("task-retry-button"));
    return { cssExists: !!rule, css: rule ? rule.cssText : "" };
  });
  out.push("重试按钮CSS: " + JSON.stringify(retryStyle));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
