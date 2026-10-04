// AI 生成中心浏览器验收：设置 / 角色形象库 / 生成弹层 / 队列 / 自动挂载。
// Usage: NODE_PATH=<playwright location> node tests/browser_ai.cjs <base URL>
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:8877';
const out = path.resolve('.qa/browser-ai');

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  const lib = async () => (await context.request.get(base + '/api/library')).json();
  const api = async (route, body, method = 'POST') => {
    const library = await lib();
    const res = await context.request.fetch(base + route, { method, data: body, headers: { 'X-CSRF-Token': library.csrf_token } });
    assert(res.ok(), route + ': ' + await res.text());
    return res.json();
  };
  const waitTask = async (taskId, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await (await context.request.get(base + '/api/ai/tasks/' + taskId)).json();
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
      await page.waitForTimeout(400);
    }
    throw new Error('AI task timed out: ' + taskId);
  };

  // 0. 开启 AI 生成（隔离实例默认关闭，模拟平台可用）＋ 预置 mock 视频模板
  await api('/api/ai/config', { enabled: true, default_ratio: '9:16', default_duration: 10 });
  const box = (kind, content) => Buffer.concat([Buffer.from((8 + content.length).toString(16).padStart(8, '0'), 'hex'), kind, content]);
  const mp4 = Buffer.concat([box(Buffer.from('ftyp'), Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)])),
                             box(Buffer.from('moov'), Buffer.alloc(0)), box(Buffer.from('mdat'), Buffer.from('sample'))]);
  const templateRes = await context.request.post(base + '/api/scripts/script-01/media', {
    multipart: { file: { name: 'mock-template.mp4', mimeType: 'video/mp4', buffer: mp4 } },
    headers: { 'X-CSRF-Token': (await lib()).csrf_token },
  });
  assert(templateRes.ok(), 'media template upload: ' + await templateRes.text());

  // 1. 内容管理页：AI 工具栏
  await page.goto(base + '/manage');
  await page.locator('#open-ai-settings').waitFor();
  await page.locator('#open-ai-characters').waitFor();
  await page.screenshot({ path: path.join(out, 'manage-ai-toolbar.png'), fullPage: true });

  // 2. AI 生成设置对话框
  await page.locator('#open-ai-settings').click();
  await page.locator('#ai-settings-dialog[open]').waitFor();
  assert(await page.locator('#ai-enabled').isChecked(), 'AI enabled checkbox should reflect config');
  await page.locator('#ai-byte-key').fill('ark-test-dummy');
  await page.locator('#ai-settings-form button[type=submit]').click();
  await page.locator('#ai-settings-dialog').waitFor({ state: 'hidden' });
  const saved = await (await context.request.get(base + '/api/ai/config')).json();
  assert.equal(saved.config.platforms.byte.api_key, 'ark-test-dummy');
  await page.locator('#open-ai-settings').click();
  await page.locator('#ai-byte-key').fill('');
  await page.locator('#ai-settings-form button[type=submit]').click();
  await page.locator('#ai-settings-dialog').waitFor({ state: 'hidden' });

  // 3. 角色形象库：新建角色 → 生成形象 → 绑定应用到剧本
  // 先清理历史同名测试角色，保证可重复运行
  const existingCharacters = await (await context.request.get(base + '/api/ai/characters')).json();
  for (const item of (existingCharacters.characters || [])) {
    if (item.name.startsWith('浏览器验收角色')) {
      await context.request.fetch(base + '/api/ai/characters/' + item.id, { method: 'DELETE', headers: { 'X-CSRF-Token': (await lib()).csrf_token } });
    }
  }
  const characterName = '浏览器验收角色' + Date.now().toString().slice(-6);
  await page.locator('#open-ai-characters').click();
  await page.locator('#ai-characters-dialog[open]').waitFor();
  await page.locator('#ai-character-name').fill(characterName);
  await page.locator('#ai-character-description').fill('短发少女，红色外套');
  await page.locator('#ai-character-form button[type=submit]').click();
  await page.locator('.ai-character-row').first().waitFor();
  await page.waitForTimeout(300);
  const list = await (await context.request.get(base + '/api/ai/characters')).json();
  const character = list.characters.find(item => item.name === characterName);
  assert(character, 'character should be created');
  await page.locator('#ai-character-generate').click();
  await page.waitForFunction(() => !document.getElementById('ai-character-generate').disabled, null, { timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + 45000;
  let card = null;
  while (Date.now() < deadline) {
    card = (await (await context.request.get(base + '/api/ai/characters')).json()).characters.find(item => item.id === character.id);
    if (card && card.image_file) break;
    await page.waitForTimeout(500);
  }
  assert(card && card.image_file, 'character card image should be generated');
  await api('/api/ai/characters/' + character.id + '/uses', { script_id: 'script-01', script_title: '万有引力', alias: '验角' });
  await page.locator('[data-ai-characters-close]').click();
  await page.locator('#ai-characters-dialog').waitFor({ state: 'hidden' });
  await page.locator('#open-ai-characters').click();
  await page.locator('#ai-characters-dialog[open]').waitFor();
  await page.locator('.ai-character-row', { hasText: characterName }).click();
  await page.waitForTimeout(300);
  const usesText = await page.locator('#ai-character-uses').innerText().catch(() => '');
  assert(usesText.includes('万有引力') || usesText.includes('验角'), 'uses should be listed: ' + usesText);
  await page.screenshot({ path: path.join(out, 'characters-dialog.png') });
  await page.locator('[data-ai-characters-close]').click();
  await page.locator('#ai-characters-dialog').waitFor({ state: 'hidden' });

  // 4. 音视频配本页：AI 生成弹层 → 提交 → 队列 → 自动挂载
  await page.goto(base + '/script/script-01/media');
  await page.locator('#media-ai-generate').waitFor();
  await page.locator('#media-ai-generate').click();
  await page.locator('#ai-video-dialog[open]').waitFor();
  await page.waitForFunction(() => document.getElementById('ai-video-block') && document.getElementById('ai-video-block').options.length > 0);
  const blockId = await page.locator('#ai-video-block').inputValue();
  // 参考角色选择已生成的浏览器验收角色
  const roleOption = page.locator('#ai-video-character option', { hasText: characterName });
  if (await roleOption.count()) { await roleOption.first().evaluate(el => el.selected = true); }
  await page.locator('#ai-video-prompt').fill('角色在阳光下回头微笑');
  await page.screenshot({ path: path.join(out, 'ai-video-dialog.png') });
  await page.locator('#ai-video-form button[type=submit]').click();
  await page.locator('#ai-video-dialog').waitFor({ state: 'hidden' });
  // 队列浮层出现
  await page.locator('#ai-task-float').waitFor({ state: 'visible' });
  await page.waitForTimeout(1200);
  const task = (await (await context.request.get(base + '/api/ai/tasks?limit=10')).json()).tasks[0];
  assert(task.kind === 'video', 'latest task should be a video task');
  const finished = await waitTask(task.task_id);
  assert.equal(finished.status, 'succeeded', finished.error || finished.status);
  // 自动挂载：剧本媒体位出现 AI 视频且 0s 时间点指向目标段落
  const library = await lib();
  const script = library.scripts.find(item => item.id === 'script-01');
  assert(script.media, 'AI video should auto-attach to script media');
  assert.equal(script.media.cues[0].block_ids[0], blockId);
  assert.equal(script.media.cues[0].at, 0);
  await page.waitForTimeout(1600); // 等待页面自动刷新
  await page.screenshot({ path: path.join(out, 'media-after-attach.png'), fullPage: true });

  // 5. 任务浮层与失败重试路径（用一个必失败的 mock 不适用，跳过；仅确认浮层渲染无错）
  assert.deepEqual(errors, [], 'browser runtime errors: ' + errors.join(' | '));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({
    passed: true, character: character.name, videoTask: finished.status,
    attached: { name: script.media.name, cues: script.media.cues.length }, browserErrors: errors,
  }, null, 2));
  await browser.close();
  console.log('AI browser acceptance passed. Screenshots: ' + out);
})().catch(error => { console.error(error); process.exit(1); });
