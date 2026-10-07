// AI 功能演示：完整走一遍 mock 流程并截图
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:8878';
const out = path.resolve('.qa/demo-ai');

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const lib = async () => (await context.request.get(base + '/api/library')).json();
  const api = async (route, body, method = 'POST') => {
    const library = await lib();
    const res = await context.request.fetch(base + route, { method, data: body, headers: { 'X-CSRF-Token': library.csrf_token } });
    if (!res.ok()) throw new Error(route + ': ' + await res.text());
    return res.json();
  };
  // 准备：模板 mp4 + 开启 AI
  const box = (kind, content) => Buffer.concat([Buffer.from((8 + content.length).toString(16).padStart(8, '0'), 'hex'), kind, content]);
  const mp4 = Buffer.concat([box(Buffer.from('ftyp'), Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)])),
                             box(Buffer.from('moov'), Buffer.alloc(0)), box(Buffer.from('mdat'), Buffer.from('sample'))]);
  await context.request.post(base + '/api/scripts/script-01/media', {
    multipart: { file: { name: 'template.mp4', mimeType: 'video/mp4', buffer: mp4 } },
    headers: { 'X-CSRF-Token': (await lib()).csrf_token },
  });
  await api('/api/ai/config', { enabled: true });

  // 1. 主页
  await page.goto(base + '/');
  await page.locator('#script-grid > *').first().waitFor();
  await page.screenshot({ path: path.join(out, '01-主页.png'), fullPage: true });

  // 2. 内容管理页（AI 工具栏）
  await page.goto(base + '/manage');
  await page.locator('#open-ai-characters').waitFor();
  await page.screenshot({ path: path.join(out, '02-内容管理-AI工具栏.png'), fullPage: true });

  // 3. AI 生成设置
  await page.locator('#open-ai-settings').click();
  await page.locator('#ai-settings-dialog[open]').waitFor();
  await page.screenshot({ path: path.join(out, '03-AI生成设置.png') });
  await page.locator('[data-ai-settings-close]').first().click();
  await page.locator('#ai-settings-dialog').waitFor({ state: 'hidden' });

  // 4. 角色形象库：新建 + 生成形象
  await page.locator('#open-ai-characters').click();
  await page.locator('#ai-characters-dialog[open]').waitFor();
  await page.locator('#ai-character-name').fill('演示角色·喜娃');
  await page.locator('#ai-character-description').fill('红色长发的温柔女主播，白色连衣裙');
  await page.locator('#ai-character-form button[type=submit]').click();
  await page.locator('.ai-character-row').first().waitFor();
  await page.waitForTimeout(300);
  await page.locator('#ai-character-generate').click();
  await page.waitForFunction(() => !document.getElementById('ai-character-generate').disabled, null, { timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const data = (await (await context.request.get(base + '/api/ai/characters')).json()).characters;
    const c = data.find(x => x.name === '演示角色·喜娃');
    if (c && c.image_file) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, '04-角色形象库-已生成形象.png') });
  await page.locator('[data-ai-characters-close]').first().click();
  await page.locator('#ai-characters-dialog').waitFor({ state: 'hidden' });

  // 5. 音视频配本页：AI 生成弹层
  await page.goto(base + '/script/script-01/media');
  await page.locator('#media-ai-generate').waitFor();
  await page.screenshot({ path: path.join(out, '05-音视频配本-AI按钮.png'), fullPage: true });
  await page.locator('#media-ai-generate').click();
  await page.locator('#ai-video-dialog[open]').waitFor();
  await page.waitForFunction(() => document.getElementById('ai-video-block') && document.getElementById('ai-video-block').options.length > 0);
  const roleOption = page.locator('#ai-video-character option', { hasText: '演示角色·喜娃' });
  if (await roleOption.count()) { await roleOption.first().evaluate(el => el.selected = true); }
  await page.locator('#ai-video-prompt').fill('女主播在直播间温柔地读出剧本台词，镜头缓缓推近');
  await page.screenshot({ path: path.join(out, '06-AI生成弹层.png') });

  // 6. 提交 → 队列 → 自动挂载
  await page.locator('#ai-video-form button[type=submit]').click();
  await page.locator('#ai-video-dialog').waitFor({ state: 'hidden' });
  await page.locator('#ai-task-float').waitFor({ state: 'visible' });
  await page.waitForTimeout(3200);
  await page.screenshot({ path: path.join(out, '07-任务队列浮层.png') });
  const task = (await (await context.request.get(base + '/api/ai/tasks?limit=5')).json()).tasks[0];
  const deadline2 = Date.now() + 30000;
  while (Date.now() < deadline2) {
    const t = await (await context.request.get(base + '/api/ai/tasks/' + task.task_id)).json();
    if (t.status === 'succeeded') break;
    if (t.status === 'failed') throw new Error('task failed: ' + t.error);
    await page.waitForTimeout(400);
  }
  const library = await lib();
  const script = library.scripts.find(s => s.id === 'script-01');
  await page.waitForTimeout(1800); // 等自动刷新
  await page.screenshot({ path: path.join(out, '08-自动挂载后.png'), fullPage: true });
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({
    character: '演示角色·喜娃', videoTask: task.task_id,
    attached: { name: script.media ? script.media.name : null, cues: script.media ? script.media.cues.length : 0, block: script.media && script.media.cues[0] ? script.media.cues[0].block_ids[0] : null },
  }, null, 2));
  await browser.close();
  console.log('Demo done: ' + out);
})().catch(e => { console.error(e); process.exit(1); });
