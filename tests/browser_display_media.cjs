// 段落媒体：display 上屏 + reader 阅读页的媒体卡渲染与点击播放验收
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:8878';
const out = path.resolve('.qa/block-media-display');

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const lib = await (await context.request.get(base + '/api/library')).json();
  const target = lib.scripts.find(s => (s.blocks || []).some(b => b.kind === 'video' || b.kind === 'audio'));
  if (!target) throw new Error('隔离库没有含媒体段的剧本');
  console.log('target:', target.title);
  await context.request.post(base + '/api/apply', { data: { mode: 'script', script_id: target.id, orientation: 'portrait' }, headers: { 'X-CSRF-Token': lib.csrf_token } });

  // --- display 独立展示（先跑） ---
  const displayPage = await context.newPage();
  await displayPage.setViewportSize({ width: 600, height: 1000 });
  displayPage.on('pageerror', e => console.log('DISP PAGEERROR', String(e).slice(0, 300)));
  await displayPage.goto(base + '/display');
  await displayPage.locator('.media-card').first().waitFor({ timeout: 20000 });
  const dcard = displayPage.locator('.media-card').first();
  const displayPlayState = await dcard.evaluate(el => {
    const c = el;
    const p = c.closest('.media-block').querySelector('video,audio');
    c.click();
    return { cardHidden: c.hidden, playerHidden: p.hidden };
  });
  if (!(displayPlayState.cardHidden && !displayPlayState.playerHidden)) throw new Error('display 点击未展开播放器: ' + JSON.stringify(displayPlayState));
  await displayPage.waitForTimeout(300);
  await displayPage.screenshot({ path: path.join(out, '03-display-媒体卡.png') });
  await displayPage.screenshot({ path: path.join(out, '04-display-点击播放.png') });

  // --- reader 阅读页（后跑） ---
  const page = await context.newPage();
  await page.goto(base + '/script/' + encodeURIComponent(target.id));
  await page.locator('.media-card').first().waitFor();
  await page.screenshot({ path: path.join(out, '01-reader-媒体卡.png'), fullPage: true });
  const card = page.locator('.media-card').first();
  const readerPlayState = await card.evaluate(el => {
    const c = el;
    const p = c.closest('.media-block').querySelector('video,audio');
    c.click();
    return { cardHidden: c.hidden, playerHidden: p.hidden };
  });
  if (!(readerPlayState.cardHidden && !readerPlayState.playerHidden)) throw new Error('reader 点击未展开播放器: ' + JSON.stringify(readerPlayState));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '02-reader-点击播放.png'), fullPage: true });

  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({
    target: target.title,
    readerMediaCards: await page.locator('.media-card').count(),
    displayMediaCards: await displayPage.locator('.media-card').count(),
    readerClickedPlayable: readerPlayState.cardHidden && !readerPlayState.playerHidden,
    displayClickedPlayable: displayPlayState.cardHidden && !displayPlayState.playerHidden,
  }, null, 2));
  await browser.close();
  console.log('Display/reader media acceptance done: ' + out);
})().catch(e => { console.error(e); process.exit(1); });
