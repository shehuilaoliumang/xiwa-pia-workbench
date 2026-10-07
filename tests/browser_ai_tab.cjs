// 验收：内容管理第 5 tab「AI 生成」+ 16 篇剧本
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:8878';
const out = path.resolve('.qa/ai-tab');

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
  await page.goto(base + '/manage');
  await page.locator('#tab-ai').waitFor({ timeout: 15000 });

  // 1. tab 栏与剧本数量
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-tab]')].map(b => ({ id: b.id, text: b.textContent.trim() })));
  const scriptsVisible = await page.evaluate(() => document.querySelectorAll('#manage-script-list [data-script-id], #manage-script-list .script-row, #manage-script-list tr').length);

  // 2. 剧本资料面板不应再有 AI 工具栏
  const aiToolbarGone = await page.evaluate(() => !document.querySelector('#manage-scripts .ai-manage-toolbar'));

  // 3. 点击 AI 生成 tab
  await page.locator('#tab-ai').click();
  await page.locator('#manage-ai:not([hidden])').waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  const aiPanel = await page.evaluate(() => ({
    hidden: document.querySelector('#manage-ai').hidden,
    status: document.querySelector('#ai-panel-status')?.textContent || '',
    hasSettings: !!document.querySelector('#open-ai-settings'),
    hasCharacters: !!document.querySelector('#open-ai-characters'),
  }));
  await page.screenshot({ path: path.join(out, '01-AI生成-tab面板.png') });

  // 4. 打开 AI 设置对话框
  await page.locator('#open-ai-settings').click();
  await page.locator('#ai-settings-dialog[open]').waitFor({ timeout: 10000 });
  const settingsOpen = await page.evaluate(() => document.querySelector('#ai-settings-dialog').open);
  await page.screenshot({ path: path.join(out, '02-AI生成设置-对话框.png') });
  await page.locator('#ai-settings-dialog [data-ai-settings-close]').first().click();

  // 5. 打开角色形象库对话框
  await page.locator('#open-ai-characters').click();
  await page.locator('#ai-characters-dialog[open]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  const charsDialog = await page.evaluate(() => ({
    open: document.querySelector('#ai-characters-dialog').open,
    listItems: document.querySelectorAll('#ai-characters-list .ai-character-row, #ai-characters-list li, #ai-characters-list [data-character-id]').length,
  }));
  await page.screenshot({ path: path.join(out, '03-角色形象库-对话框.png') });
  await page.locator('#ai-characters-dialog [data-ai-characters-close]').first().click();

  // 6. 剧本资料 tab 恢复正常
  await page.locator('#tab-scripts').click();
  const scriptsBack = await page.evaluate(() => ({
    hidden: document.querySelector('#manage-scripts').hidden,
    aiToolbarGone: !document.querySelector('#manage-scripts .ai-manage-toolbar'),
  }));

  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({
    tabs: tabs.map(t => t.text),
    scriptsInLibrary: scriptsVisible,
    aiToolbarRemovedFromScripts: aiToolbarGone,
    aiPanel: aiPanel,
    settingsDialogOpens: settingsOpen,
    charactersDialogOpens: charsDialog.open,
    characterRows: charsDialog.listItems,
    scriptsTabBack: scriptsBack,
  }, null, 2));
  await browser.close();
  console.log('AI tab acceptance done: ' + out);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
