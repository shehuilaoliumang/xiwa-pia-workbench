// 验证：清除 AI 队列使用自定义 dialog（替代原生 confirm），取消/确认两路径 + 角色删除 dialog
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1300);
  await p.click("#tab-ai");
  await p.waitForTimeout(700);

  const dialogState = () => p.evaluate(() => {
    const d = document.getElementById("pia-confirm-dialog");
    return { exists: !!d, open: d && d.open, title: d && document.getElementById("pia-confirm-title").textContent, msg: d && document.getElementById("pia-confirm-message").textContent, okText: d && d.querySelector("[data-pia-confirm-ok]").textContent };
  });

  // 1) 点「清除」→ 自定义 dialog 弹出
  await p.click("#ai-task-float-clear");
  await p.waitForTimeout(400);
  let s = await dialogState();
  out.push("清除弹出: " + JSON.stringify(s));
  if (!s.open) throw new Error("清除未弹出自定义确认框");

  // 2) 取消路径 → dialog 关闭，任务列表仍在
  await p.click("#pia-confirm-dialog [data-pia-confirm-cancel]");
  await p.waitForTimeout(400);
  s = await dialogState();
  const itemCount = await p.evaluate(() => document.querySelectorAll(".ai-task-item").length);
  out.push("取消后: open=" + s.open + " 任务项=" + itemCount);

  // 3) 确认路径 → DELETE 调用 → 队列刷新无报错
  await p.click("#ai-task-float-clear");
  await p.waitForTimeout(300);
  const csrf = await p.evaluate(() => document.querySelector('meta[name="csrf-token"]').content);
  const before = await p.evaluate((t) => fetch("/api/ai/tasks", { headers: { "X-CSRF-Token": t } }).then((r) => r.json()).then((d) => (d.tasks || []).length).catch(() => -1), csrf);
  await p.click("#pia-confirm-dialog [data-pia-confirm-ok]");
  await p.waitForTimeout(900);
  const after = await p.evaluate((t) => fetch("/api/ai/tasks", { headers: { "X-CSRF-Token": t } }).then((r) => r.json()).then((d) => (d.tasks || []).length).catch(() => -2), csrf);
  out.push("确认清除: 之前=" + before + " 之后=" + after + " (应减少或持平，运行中任务保留)");
  const errText = await p.evaluate(() => { const e = document.querySelector(".ai-float-error, #ai-float-error"); return e && !e.hidden ? e.textContent : ""; });
  out.push("清除后错误区: " + (errText || "(空)"));

  // 4) 角色库删除 → 自定义 dialog（不确认）
  await p.click("#open-ai-characters");
  await p.waitForTimeout(600);
  const roleDelete = await p.evaluate(() => {
    const btn = document.querySelector("#ai-character-delete");
    return { exists: !!btn, disabled: btn && btn.disabled };
  });
  if (roleDelete.exists && !roleDelete.disabled) {
    await p.click("#ai-character-delete");
    await p.waitForTimeout(400);
    s = await dialogState();
    out.push("角色删除弹出: " + JSON.stringify({ open: s.open, title: s.title }));
    await p.click("#pia-confirm-dialog [data-pia-confirm-cancel]");
  } else {
    out.push("角色删除按钮: " + JSON.stringify(roleDelete) + "（无选中角色则跳过）");
  }

  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
