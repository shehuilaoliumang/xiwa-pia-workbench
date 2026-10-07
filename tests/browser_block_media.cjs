// 段落级媒体：编辑器插入/保存/重开渲染验收
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const base = 'http://127.0.0.1:8878';
const out = path.resolve('.qa/block-media');

(async () => {
  await fs.mkdir(out, { recursive: true });
  // 构造最小合法 mp4（ftyp isom + moov + mdat，通过 validate_media_stream）
  const box = (tag, payload) => Buffer.concat([Buffer.from((8 + payload.length).toString(16).padStart(8, '0'), 'hex'), tag, payload]);
  const mp4 = Buffer.concat([box(Buffer.from('ftyp'), Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)])),
                             box(Buffer.from('moov'), Buffer.alloc(0)), box(Buffer.from('mdat'), Buffer.from('demo-video-bytes'))]);
  const mp4Path = path.join(os.tmpdir(), 'block-demo.mp4');
  await fs.writeFile(mp4Path, mp4);

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  // 打开内容管理 → 编辑第一篇剧本
  await page.goto(base + '/manage');
  await page.locator('#tab-scripts').waitFor();
  await page.locator('[data-edit-script]').first().waitFor();
  await page.locator('[data-edit-script]').first().click();
  await page.locator('#script-dialog[open]').waitFor();
  await page.locator('#body-editor-details').click();
  await page.locator('#body-editor').waitFor();
  await page.screenshot({ path: path.join(out, '01-编辑器-初始.png') });

  // 点击"添加音视频" → 上传 mock mp4
  await page.locator('#add-media-block').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#script-media-file').evaluate(el => el.click());
  const chooser = await chooserPromise;
  await chooser.setFiles(mp4Path);
  await page.waitForFunction(() => document.getElementById('script-media-status').textContent.includes('已加入草稿'), null, { timeout: 20000 });
  await page.screenshot({ path: path.join(out, '02-编辑器-已插入视频段落.png') });

  // 保存剧本
  await page.locator('#script-form button[type="submit"]').click();
  await page.locator('#script-dialog').waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);

  // 重新打开剧本确认 video block 渲染
  await page.locator('[data-edit-script]').first().click();
  await page.locator('#script-dialog[open]').waitFor();
  await page.locator('#body-editor-details').click();
  await page.locator('.script-media-card').first().waitFor();
  await page.screenshot({ path: path.join(out, '03-重开-视频段落卡片.png') });

  // 段落级媒体在导出 ZIP 中
  const library = await (await context.request.get(base + '/api/library')).json();
  const script = library.scripts.find(s => s.title.includes('万有引力') || true);
  const exportRes = await context.request.get(base + '/api/scripts/' + library.scripts[0].id + '/export');
  const zipBuf = await exportRes.body();
  // 解压检查 assets
  const zlib = require('node:zlib');
  const entries = [];
  let offset = 0;
  while (offset < zipBuf.length) {
    if (zipBuf.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLen = zipBuf.readUInt16LE(offset + 26), extraLen = zipBuf.readUInt16LE(offset + 28);
    const name = zipBuf.toString('utf8', offset + 30, offset + 30 + nameLen);
    const localOffset = offset + 30 + nameLen + extraLen;
    const method = zipBuf.readUInt16LE(offset + 8);
    const compSize = zipBuf.readUInt32LE(offset + 18);
    entries.push({ name, method, compSize });
    offset = localOffset + compSize;
  }
  const mediaAssets = entries.filter(e => e.name.startsWith('assets/') && /\.(mp4|webm|mp3|wav|m4a|ogg)$/.test(e.name));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({
    insertedBlockKinds: (script.blocks || []).map(b => b.kind),
    exportZipEntries: entries.map(e => e.name),
    mediaAssetsInZip: mediaAssets.map(e => e.name),
  }, null, 2));
  await browser.close();
  console.log('Block media browser acceptance done: ' + out);
})().catch(e => { console.error(e); process.exit(1); });
