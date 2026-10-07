// 检查卡片监听器 + 手动 dispatchEvent
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const debug = await page.evaluate(() => {
    const card = document.querySelector("#media-block-choices .media-block-media.is-video");
    if (!card) return { found: false };
    const group = card.parentElement;
    const wrap = group.querySelector(".media-block-player-wrap");
    // 1) 手动 dispatch 一个可取消的 click
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    const dispatchResult = card.dispatchEvent(evt);
    const afterDispatch = wrap ? wrap.hidden : "no-wrap";
    // 2) 检查被分派时 preventDefault 是否生效（dispatchEvent 返回 !defaultPrevented）
    return {
      found: true,
      afterDispatchHidden: afterDispatch,
      defaultPrevented: evt.defaultPrevented,
      dispatchResult,
      cardHiddenAfter: card.hidden,
      buttonType: card.type,
      disabled: card.disabled,
      innerHTML: card.innerHTML.slice(0, 80),
    };
  });
  out.push("手动dispatch: " + JSON.stringify(debug));
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
