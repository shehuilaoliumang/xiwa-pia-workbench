const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const result = await p.evaluate(async () => {
    const token = document.querySelector('meta[name="csrf-token"]').content;
    const resp = await fetch("/api/ai/byte/activations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ ak: "AKLT_invalid_test", sk: "invalid_sk" }),
    });
    return await resp.json();
  });
  console.log("假凭证返回:", JSON.stringify(result));
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
