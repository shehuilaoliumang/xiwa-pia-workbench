// Actual display renderer, driven by unsaved editor drafts in an isolated library.
'use strict';
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), python = path.join(root, 'runtime', 'python.exe');
const data = path.join(root, '.qa', 'editor-preview-' + Date.now()), port = 8937, base = 'http://127.0.0.1:' + port;
const output = path.join(root, '.qa', 'browser');
const result = {passed: false, checks: [], errors: [], screenshots: []};
let browser, child, context, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(100); }
  throw Error('Timed out: ' + label);
}
async function get(url) { const r = await context.request.get(base + url); assert(r.ok(), await r.text()); return r.json(); }
async function post(url, body) {
  const r = await context.request.post(base + url, {headers: {'X-CSRF-Token': (await get('/api/library')).csrf_token}, data: body});
  assert(r.ok(), await r.text()); return r.json();
}
function check(label) { result.checks.push(label); }
async function rendered() {
  await until(async () => (await page.locator('#editor-preview-status').textContent()).includes('已更新到当前草稿'), 'current draft render');
}
async function shot(name) {
  const target = path.join(output, name); await page.screenshot({path: target}); result.screenshots.push(target);
}
async function currentPage(frame) { return Number(await frame.locator('.stage-page.is-current').getAttribute('data-page-index')); }
async function bounds(label) {
  await delay(450);
  const geometry = await page.evaluate(() => {
    const rect = selector => {const element=document.querySelector(selector);if(!element)return null;const box=element.getBoundingClientRect();return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height};};
    return {viewport:{width:innerWidth,height:innerHeight},dialog:rect('#script-dialog'),panel:rect('#editor-preview-panel'),slot:rect('.editor-preview-stage-slot'),canvas:rect('#editor-preview-frame'),navigation:rect('.editor-preview-navigation'),footer:rect('#script-form > .dialog-actions'),left:rect('.editor-edit-pane')};
  });
  const inside = (inner,outer,name) => {assert(inner&&outer,`${label}: missing ${name}`);assert(inner.width>0&&inner.height>0,`${label}: zero-size ${name}`);assert(inner.x>=outer.x-2&&inner.right<=outer.right+2&&inner.y>=outer.y-2&&inner.bottom<=outer.bottom+2,`${label}: ${name} out of bounds ${JSON.stringify(geometry)}`);};
  const screen={x:0,y:0,right:geometry.viewport.width,bottom:geometry.viewport.height};
  inside(geometry.dialog,screen,'dialog');inside(geometry.panel,geometry.dialog,'preview panel');inside(geometry.slot,geometry.panel,'canvas slot');inside(geometry.canvas,geometry.slot,'canvas');inside(geometry.navigation,geometry.panel,'pager');inside(geometry.footer,geometry.dialog,'footer');
  assert(geometry.navigation.bottom<=geometry.footer.y+2,`${label}: pager hidden by footer`);assert(geometry.canvas.bottom<=geometry.navigation.y+2,`${label}: canvas overlaps pager`);
  result.geometry ||= {};result.geometry[label]=geometry;return geometry;
}
async function selection(field) {return field.evaluate(element=>({value:element.value,start:element.selectionStart,end:element.selectionEnd,active:document.activeElement===element}));}
async function focused(frame,id) {
  await until(async()=>await frame.locator('.stage-page.is-current [data-anchor="'+id+'"].preview-selected').count()>0,'preview highlight '+id);
}
(async () => {
  await fs.mkdir(output, {recursive: true});
  let occupied = false; try { await fetch(base + '/api/health'); occupied = true; } catch (_) {}
  assert(!occupied, 'Do not reuse an occupied QA port');
  child = spawn(python, ['-X', 'utf8', 'run.py', '--no-browser', '--port', String(port), '--data-dir', data], {cwd: root, windowsHide: true, stdio: 'ignore'});
  await until(async () => { try { return path.resolve((await (await fetch(base + '/api/health')).json()).data_dir) === data; } catch (_) { return false; } }, 'isolated server');
  browser = await chromium.launch({channel: 'msedge', headless: true});
  context = await browser.newContext({viewport: {width: 1560, height: 1100}});
  page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  const initial = await get('/api/library');
  const sourceImage = initial.scripts.flatMap(s => s.blocks).find(b => b.kind === 'image');
  const blocks = Array.from({length: 9}, (_, i) => ({kind: 'text', role: i % 2 ? '乙' : '甲', color: i % 2 ? '#224488' : '#aa3344',
    text: (i % 2 ? '乙' : '甲') + '：' + ('第' + (i + 1) + '段排版预览，长台词仍保留完整文字与颜色。').repeat(18)}));
  if (sourceImage) blocks.push({kind: 'image', image_path: sourceImage.image_path, text: ''});
  const response = await post('/api/scripts', {title: '编辑预览专项', category_id: initial.categories[0].id, blocks});
  const fixture = response.script || response;
  // A frozen audience snapshot is already on screen before any editor preview.
  await post('/api/apply', {mode: 'script', script_id: fixture.id, orientation: 'portrait'});
  const beforeLibrary = await get('/api/library'), beforeLive = await get('/api/state');
  const mutations = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && !request.url().endsWith('/api/editor-preview')) mutations.push(request.url());
  });
  await page.goto(base + '/manage'); await page.waitForFunction(() => !!window.wbEditor?.getFullDraft);
  await page.locator(`[data-edit-script="${fixture.id}"]`).click();
  await page.locator('#editor-preview-panel').evaluate(element => { element.open = true; });
  await rendered();
  const frame = page.frameLocator('#editor-preview-frame');
  assert((await frame.locator('.stage-page').count()) > 1, 'long dialogue is really paginated');
  assert.equal(await frame.locator('.stage-page.is-current').getAttribute('data-page-index'), '0');
  assert.equal(await page.locator('#editor-preview-orientation').inputValue(), 'portrait');
  check('Unsaved drafts use the actual renderer and automatic portrait pagination');
  await page.locator('#editor-preview-next').click();
  await until(async () => await frame.locator('.stage-page.is-current').getAttribute('data-page-index') === '1', 'next page');
  await page.locator('#editor-preview-previous').click();
  await until(async () => await frame.locator('.stage-page.is-current').getAttribute('data-page-index') === '0', 'previous page');
  check('Page controls operate only inside the draft preview');
  await page.locator('#edit-title').fill('尚未保存的预览标题');
  await rendered();
  await until(async () => (await frame.locator('h1').first().textContent()) === '尚未保存的预览标题', 'unsaved title');
  await page.locator('#body-editor-details').evaluate(element => { element.open = true; });
  await page.locator('[data-block-text="0"]').fill('甲：这是刚修改、尚未保存的第一句。');
  await rendered();
  await until(async () => (await frame.locator('.stage-page.is-current').textContent()).includes('刚修改'), 'unsaved body');
  const anchor = frame.locator('.stage-page.is-current [data-anchor]').first();
  await anchor.click();
  await until(async () => page.evaluate(() => document.activeElement?.hasAttribute('data-block-text')), 'preview click focuses editor');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.blockText), '0');
  check('Editing title/body updates automatically; clicking dialogue locates its editor row');
  await shot('editor-preview-portrait.png');
  await page.locator('#editor-preview-orientation').selectOption('landscape'); await rendered();
  assert(await page.locator('#script-dialog').evaluate(element => element.classList.contains('editor-preview-landscape')));
  const landscapeSize = await page.locator('#editor-preview-frame').boundingBox();
  assert(landscapeSize.width > landscapeSize.height, 'landscape canvas');
  check('Landscape uses saved landscape settings with real repagination');
  await shot('editor-preview-landscape.png');
  await page.locator('#editor-preview-mode').selectOption('scroll'); await rendered();
  assert.equal(await frame.locator('.stage-page').count(), 0, 'scroll mode is rendered without pages');
  assert.equal(await page.locator('#editor-preview-next').textContent(), '下一段');
  check('Continuous scrolling remains selectable without affecting saved display settings');
  await page.locator('#editor-preview-mode').selectOption('pages'); await rendered();
  const sameFrame = await page.locator('#editor-preview-frame').evaluate(element => { element.dataset.qaInstance = 'kept'; return element.getAttribute('src'); });
  await page.locator('#editor-preview-zoom').click();
  assert(await page.locator('#script-dialog').evaluate(element => element.classList.contains('editor-preview-focus')));
  await page.locator('#editor-preview-zoom').click();
  assert.equal(await page.locator('#editor-preview-frame').getAttribute('src'), sameFrame);
  assert.equal(await page.locator('#editor-preview-frame').getAttribute('data-qa-instance'), 'kept');
  check('Enlarging the preview retains the same iframe and draft');
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#editor-preview-orientation').selectOption('portrait'); await rendered();
  const widths = await page.locator('#script-dialog').evaluate(element => ({inner: element.clientWidth, scroll: element.scrollWidth, window: innerWidth}));
  assert(widths.scroll <= widths.inner + 2, JSON.stringify(widths));
  await page.locator('#editor-preview-panel').scrollIntoViewIfNeeded(); await shot('editor-preview-narrow.png');
  check('Narrow screens stack controls without horizontal overflow');
  await page.setViewportSize({width: 1560, height: 1100});
  let delayed = false;
  await page.route('**/api/editor-preview', async route => {
    const body = route.request().postDataJSON();
    if (body.draft.title === '较旧的延迟草稿') { delayed = true; const r = await route.fetch(); await delay(1300); try { await route.fulfill({response: r}); } catch (_) {} }
    else await route.continue();
  });
  await page.locator('#edit-title').fill('较旧的延迟草稿');
  await until(async () => delayed, 'delayed preview request started');
  await page.locator('#edit-title').fill('最新草稿仍应保留');
  await rendered(); await delay(1500);
  assert.equal(await frame.locator('h1').first().textContent(), '最新草稿仍应保留');
  await page.unroute('**/api/editor-preview');
  check('A late response cannot replace the latest draft preview');
  // Real imported long script: no short fixture can expose independent scrolling.
  await page.locator('#script-form > .dialog-actions [data-close="script-dialog"]').click();
  const longScript = initial.scripts.find(script => script.title === '万有引力');
  assert(longScript && longScript.blocks.length >= 50, 'source-based long script fixture');
  await page.locator('[data-edit-script="'+longScript.id+'"]').click();
  await page.locator('#body-editor-details').evaluate(element=>{element.open=true;});
  await page.locator('#editor-preview-panel').evaluate(element=>{element.open=true;});
  await rendered(); await page.setViewportSize({width:1440,height:900}); await bounds('long-portrait-top-1440x900'); await shot('editor-preview-long-top.png');
  const textBlocks=longScript.blocks.map((block,index)=>({block,index})).filter(({block})=>block.kind!=='image'),last=textBlocks.at(-1),first=textBlocks[0];
  const lastText=page.locator('[data-block-text="'+last.index+'"]'),firstText=page.locator('[data-block-text="'+first.index+'"]');
  const stationary = await page.locator('#editor-preview-frame').boundingBox();
  await lastText.focus(); await lastText.evaluate(element=>element.setSelectionRange(3,7)); await focused(frame,last.block.id);
  let caret=await selection(lastText);assert(caret.active&&caret.start===3&&caret.end===7,JSON.stringify(caret));
  assert((await currentPage(frame))>0,'last edited paragraph selects its actual page');
  const moved=await page.locator('#editor-preview-frame').boundingBox();assert(Math.abs(moved.y-stationary.y)<=2,'left scroll never displaces preview');
  assert(await page.locator('.editor-edit-pane').evaluate(element=>element.scrollTop>0),'last textarea scrolls only the left pane');
  assert(await page.locator('[data-block-id="'+last.block.id+'"]').evaluate(element=>element.classList.contains('editor-linked-block')));
  await bounds('long-portrait-last-1440x900');await shot('editor-preview-long-last.png');
  for (const attribute of ['role','color','text']) {
    const field=page.locator('[data-block-'+attribute+'="'+first.index+'"]');await field.focus();await focused(frame,first.block.id);assert(await field.evaluate(element=>document.activeElement===element),'preview focus should never steal '+attribute+' editor focus');
  }
  check('A real 56-paragraph script links textarea, role and color focus to the matching preview page without moving the right pane or stealing input focus');
  // Clicking the same preview sentence keeps the selected caret. Clicking another
  // sentence intentionally focuses its editor textarea, with only left-pane scroll.
  await lastText.focus();await lastText.evaluate(element=>element.setSelectionRange(4,8));await focused(frame,last.block.id);
  await frame.locator('.stage-page.is-current [data-anchor="'+last.block.id+'"]').first().click();
  caret=await selection(lastText);assert(caret.active&&caret.start===4&&caret.end===8,'same-sentence preview click preserves current caret');
  await page.evaluate(()=>{window.__editorFocusAcks=0;window.addEventListener('message',event=>{if(event.data?.type==='wb-editor-focused')window.__editorFocusAcks++;});});
  const clickTarget=await frame.locator('.stage-page.is-current [data-anchor]').evaluateAll(elements=>elements.find(element=>element.dataset.anchor!==elements.at(-1)?.dataset.anchor)?.dataset.anchor || null);
  if (clickTarget && clickTarget!==last.block.id) {
    const clickBlock=textBlocks.find(({block})=>block.id===clickTarget);assert(clickBlock,'visible preview anchor maps to an editable source row');
    await frame.locator('.stage-page.is-current [data-anchor="'+clickTarget+'"]').first().click();
    await until(async()=>await page.locator('[data-block-text="'+clickBlock.index+'"]').evaluate(element=>document.activeElement===element),'preview-to-editor focus');
    assert(await page.locator('[data-block-id="'+clickTarget+'"]').evaluate(element=>element.classList.contains('editor-linked-block')));
  }
  const acks=await page.evaluate(()=>window.__editorFocusAcks);await delay(400);assert.equal(await page.evaluate(()=>window.__editorFocusAcks),acks,'no cross-window focus loop');
  check('Preview clicks locate the corresponding left row; clicking the currently edited sentence preserves caret and focus feedback does not loop');
  await lastText.focus();await focused(frame,last.block.id);await lastText.fill(last.block.text+'（草稿分页定位核验）');await lastText.evaluate(element=>element.setSelectionRange(2,5));await rendered();await focused(frame,last.block.id);
  caret=await selection(lastText);assert(caret.active&&caret.start===2&&caret.end===5,'repagination must retain editor caret');assert((await currentPage(frame))>0,'repagination retains the current edited target');
  check('Text-triggered repagination retains the current target and selection while leaving saved content untouched');
  // Reproduce a late server response while the active editor target changes.
  let focusDelayed=false,finishDelayed;
  await page.route('**/api/editor-preview',async route=>{const body=route.request().postDataJSON();if(body.draft.title==='定位延迟旧稿'){focusDelayed=true;const response=await route.fetch();await new Promise(resolve=>{finishDelayed=resolve;});await route.fulfill({response}).catch(()=>{});}else await route.continue();});
  await page.locator('#edit-title').fill('定位延迟旧稿');await until(()=>focusDelayed,'focus delayed request');
  await firstText.focus();await lastText.focus();await firstText.focus();await page.locator('#edit-title').fill('定位最新稿');await lastText.focus();await lastText.evaluate(element=>element.setSelectionRange(6,9));
  await rendered();await focused(frame,last.block.id);finishDelayed();await delay(350);await page.unroute('**/api/editor-preview');assert.equal(await frame.locator('h1').first().textContent(),'定位最新稿');await focused(frame,last.block.id);caret=await selection(lastText);assert(caret.active&&caret.start===6&&caret.end===9);
  check('Rapid editor-target changes and a late previous response keep only the latest target, title and caret');
  for (const viewport of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    for (const format of ['portrait','landscape']) {
      await page.locator('#editor-preview-orientation').selectOption(format);await rendered();await bounds(`${format}-${viewport.width}x${viewport.height}`);
      await page.locator('#editor-preview-zoom').click();await bounds(`${format}-focus-${viewport.width}x${viewport.height}`);
      assert(await page.locator('#editor-preview-frame').evaluate(element=>element.clientWidth>0&&element.clientHeight>0));
      await page.locator('#editor-preview-zoom').click();await bounds(`${format}-restored-${viewport.width}x${viewport.height}`);
      if(format==='portrait'&&viewport.width===1280)await shot('editor-preview-long-low-height.png');if(format==='portrait'&&viewport.width===390)await shot('editor-preview-long-mobile.png');
    }
  }
  check('Full portrait/landscape canvases, page controls and footer remain inside the visible dialog at 1440×900, 1280×720 and 390×844, including zoom focus');
  // One long paragraph may span many pages; focusing it again should keep the
  // currently visible fragment instead of jumping back to its first page.
  await page.setViewportSize({width:1440,height:900});await page.locator('#script-form > .dialog-actions [data-close="script-dialog"]').click();
  await page.locator('[data-edit-script="'+fixture.id+'"]').click();
  await page.evaluate(()=>localStorage.clear());
  const draftRecovery=page.locator('#editor-discard');if(await draftRecovery.isVisible()){await draftRecovery.click();const confirm=page.locator('#confirm-yes');await confirm.waitFor();await confirm.click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});}
  await page.locator('#editor-preview-panel').evaluate(element=>{element.open=true;});await page.locator('#body-editor-details').evaluate(element=>{element.open=true;});await page.locator('#editor-preview-orientation').selectOption('portrait');await page.locator('#editor-preview-mode').selectOption('pages');await rendered();
  await delay(900);await rendered();
  const repeated=await frame.locator('.stage-page').evaluateAll(pages=>{const byId=new Map();pages.forEach(page=>{for(const element of page.querySelectorAll('[data-anchor]')){const id=element.dataset.anchor;const indexes=byId.get(id)||[];if(!indexes.includes(Number(page.dataset.pageIndex)))indexes.push(Number(page.dataset.pageIndex));byId.set(id,indexes);}});return [...byId].find(([,indexes])=>indexes.length>1)||null;});
  assert(repeated,'long fixture genuinely contains a paragraph split across pages');
  const [spanningId,spanningPages]=repeated,spanningIndex=fixture.blocks.findIndex(block=>block.id===spanningId),targetPage=spanningPages[1];
  await page.evaluate(()=>{const iframe=document.querySelector('#editor-preview-frame'),trace=window.__qaFocusTrace=[];const record=(direction,data)=>{if(trace.length<100)trace.push({direction,type:data?.type,anchor:data?.anchor,page:data?.page_index,snapshot:data?.snapshot_id,dom_page:iframe.contentDocument.querySelector('.stage-page.is-current')?.dataset.pageIndex});};const original=iframe.contentWindow.postMessage.bind(iframe.contentWindow);iframe.contentWindow.postMessage=(data,...args)=>{record('parent-to-frame',data);return original(data,...args);};window.addEventListener('message',event=>{if(event.source===iframe.contentWindow)record('frame-to-parent',event.data);});document.querySelector('#script-form').addEventListener('change',event=>trace.push({direction:'editor-change',field:event.target.dataset.blockText??event.target.dataset.blockRole??event.target.id}));});
  await page.locator('[data-block-text="'+spanningIndex+'"]').focus();await focused(frame,spanningId);
  while(await currentPage(frame)<targetPage){const nextPage=(await currentPage(frame))+1;await page.locator('#editor-preview-next').click();await until(async()=>await currentPage(frame)===nextPage,'one acknowledged page turn');}
  await until(async()=>Number((await page.locator('#editor-preview-page').textContent()).split('/')[0].trim())===targetPage+1,'parent pager acknowledges cross-page navigation');await delay(500);
  assert(await frame.locator('.stage-page.is-current [data-anchor="'+spanningId+'"]').count()>0);
  await page.locator('[data-block-role="'+spanningIndex+'"]').focus();await focused(frame,spanningId);result.focus_trace=await page.evaluate(()=>window.__qaFocusTrace);assert.equal(await currentPage(frame),targetPage,'a current-page paragraph fragment is retained');
  check('Refocusing a paragraph spanning multiple pages keeps its current visible page fragment');
  assert.deepEqual(await get('/api/library'), beforeLibrary, 'preview never saves the library');
  assert.deepEqual(await get('/api/state'), beforeLive, 'preview never connects, applies, pauses or seeks the audience');
  assert.deepEqual(mutations, [], 'all interactive draft preview operations are read-only');
  assert.deepEqual(result.errors, []);
  check('Library, queue, display settings and frozen live state remain unchanged');
  result.passed = true;
  console.log('Editor preview acceptance passed (' + result.checks.length + ' groups).');
})().catch(error => {result.failure = error.stack; console.error(error); process.exitCode = 1;}).finally(async () => {
  if (page && !result.passed) try { await shot('editor-preview-failure.png'); } catch (_) {}
  if (browser) await browser.close();
  try { execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', data], {cwd: root, windowsHide: true}); } catch (_) {}
  if (child && child.exitCode === null) child.kill();
  await fs.writeFile(path.join(output, 'editor-preview-result.json'), JSON.stringify(result, null, 2));
});
