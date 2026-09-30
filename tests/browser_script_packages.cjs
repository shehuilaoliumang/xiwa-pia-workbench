// Single-script package and AI-formatting UI checks. Only a fresh QA database.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), python = path.join(root, 'runtime', 'python.exe');
const data = path.join(root, '.qa', 'script-packages-' + Date.now());
const output = path.join(root, '.qa', 'browser'), port = 8926, base = 'http://127.0.0.1:' + port;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {passed: false, data_dir: data, checks: [], page_errors: [], screenshots: []};
let child, browser, context, page, release;
fs.mkdirSync(output, {recursive: true});
async function until(check, label) {
  for (let i=0;i<200;i++) { if (await check()) return; await delay(80); }
  throw new Error('Timed out: ' + label);
}
function wav() {
  const bytes = 32000, b = Buffer.alloc(44+bytes);
  b.write('RIFF');b.writeUInt32LE(36+bytes,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(bytes,40);return b;
}
async function get(endpoint) { const r=await context.request.get(base+endpoint);assert(r.ok(),await r.text());return r.json(); }
const library = () => get('/api/library');
async function api(endpoint, method, data) {
  const token=(await library()).csrf_token;
  const r=await context.request.fetch(base+endpoint,{method,headers:{'X-CSRF-Token':token},data});const payload=await r.json();assert(r.ok(),JSON.stringify(payload));return payload;
}
async function openPackage() {
  await page.locator('#open-script-package').click();
  await page.locator('#script-package-dialog').waitFor();
  await until(async()=>!await page.locator('#script-package-check').isDisabled(),'category list');
}
async function checkFile(file) {
  await page.locator('#script-package-file').setInputFiles(file);
  await page.locator('#script-package-check').click();
}
async function ready() {
  await page.locator('#script-package-preview').waitFor();
  await until(async()=>!await page.locator('#script-package-check').isDisabled(),'file check completed');
}
async function screenshot(name) {
  const filename=path.join(output,name);await page.screenshot({path:filename,fullPage:false});result.screenshots.push(filename);
}
(async()=>{
try {
  let occupied=false;try {await fetch(base+'/api/health');occupied=true;}catch(_){}
  assert(!occupied,'Refusing to reuse occupied test port');
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port',String(port),'--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return path.resolve((await(await fetch(base+'/api/health')).json()).data_dir)===data;}catch(_){return false;}},'QA server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',error=>result.page_errors.push(error.message));
  const first=await library(), image=first.scripts.flatMap(s=>s.blocks).find(b=>b.kind==='image');
  assert(image,'seed image fixture');
  const created=await api('/api/scripts','POST',{title:'单篇交换验收',author:'QA作者',category_id:first.categories[0].id,visible:false,
    blocks:[{kind:'text',role:'甲',text:'甲：（轻声）保留原话。',color:'#334455'},{kind:'image',image_path:image.image_path,text:''},{kind:'text',role:'乙',text:'乙：保留第二句。'}]});
  const fixture=created.script || created;
  assert(fixture.id,JSON.stringify(created));
  const mediaUpload=await context.request.post(base+'/api/scripts/'+fixture.id+'/media',{headers:{'X-CSRF-Token':(await library()).csrf_token},multipart:{file:{name:'演示.wav',mimeType:'audio/wav',buffer:wav()}}});
  assert(mediaUpload.ok(),await mediaUpload.text());
  await api('/api/scripts/'+fixture.id+'/media/cues','PUT',{duration:2,cues:[{id:'cue-package-check',at:.5,label:'一起走本',block_ids:fixture.blocks.slice(0,2).map(b=>b.id)}]});
  let source=(await library()).scripts.find(s=>s.id===fixture.id);const packageTitle=source.title,beforeState=await get('/api/state'),beforeCount=(await library()).scripts.length;
  await page.goto(base+'/manage');await page.waitForFunction(()=>window.piaScriptPackages&&window.piaEditor);
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-export-script="'+fixture.id+'"]').click();
  const download=await downloadPromise,filename=path.join(data,'exported-script.zip');await download.saveAs(filename);
  assert(fs.statSync(filename).size>0);assert.equal((await library()).scripts.length,beforeCount);assert.deepEqual(await get('/api/state'),beforeState);
  // Keep the exported content and the local edited source as distinct titles so
  // this original exchange test exercises the new-script path; conflict/duplicate
  // behavior has its own browser_import_conflicts.cjs coverage.
  await api('/api/scripts/'+source.id,'PATCH',{...source,title:'本地保留本（原单篇交换验收）'});
  source=(await library()).scripts.find(s=>s.id===source.id);
  result.checks.push('UI export downloads one script without changing live or library');
  await openPackage();await checkFile(filename);await ready();
  assert.equal(await page.locator('#script-package-title').textContent(),packageTitle);
  assert.match(await page.locator('#script-package-summary').textContent(),/2 个文字段落.*1 张正文图片.*附音视频.*1 个时间点/);
  assert.match(await page.locator('#script-package-warnings').textContent(),/隐藏/);assert.match(await page.locator('#script-package-match-status').textContent(),/可新增/);
  assert(await page.locator('#script-package-confirm').isDisabled());
  await page.locator('#script-package-category').selectOption(first.categories[1].id);
  assert(!await page.locator('#script-package-confirm').isDisabled());
  await page.locator('.script-package-body > summary').click();
  assert.match(await page.locator('#script-package-content').textContent(),/保留原话/);
  await screenshot('script-package-preview-desktop.png');
  await page.locator('[data-package-close]').last().click();
  assert.equal((await library()).scripts.length,beforeCount);assert.deepEqual(await get('/api/state'),beforeState);
  result.checks.push('preview/cancel is read-only; body, media, cues, hidden and new-script summaries shown');
  await openPackage();await checkFile({name:'坏文件.zip',mimeType:'application/zip',buffer:Buffer.from('not a zip')});
  await until(async()=>!!await page.locator('#script-package-error').textContent(),'invalid ZIP error');
  assert(await page.locator('#script-package-preview').isHidden());assert(await page.locator('#script-package-confirm').isDisabled());
  const backup=await context.request.get(base+'/api/backup');assert(backup.ok());
  await checkFile({name:'整库备份.zip',mimeType:'application/zip',buffer:await backup.body()});
  await until(async()=>!!await page.locator('#script-package-error').textContent(),'whole backup rejected');
  assert(await page.locator('#script-package-confirm').isDisabled());
  result.checks.push('invalid ZIP and full backup report readable errors without writes');
  let blocked=false;
  await page.route('**/api/script-packages/preview',async route=>{
    blocked=true;await new Promise(resolve=>{release=resolve;});
    await route.continue().catch(()=>{});
  });
  await checkFile(filename);await until(()=>blocked,'delayed preview response');
  await page.locator('#script-package-file').setInputFiles({name:'换成另一份.zip',mimeType:'application/zip',buffer:Buffer.from('replacement')});
  release();release=null;await delay(200);await page.unroute('**/api/script-packages/preview');
  assert(await page.locator('#script-package-preview').isHidden());assert(await page.locator('#script-package-confirm').isDisabled());
  let csrfFailures=0;
  await page.route('**/api/script-packages/preview',async route=>{
    if(!csrfFailures++){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'csrf_failed',error:'token expired'})});}
    else await route.continue();
  });
  await checkFile(filename);await ready();await page.unroute('**/api/script-packages/preview');assert.equal(csrfFailures,2);
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const bounds=await page.locator('#script-package-dialog').boundingBox();assert(bounds.width<=390&&bounds.x>=0);
  await screenshot('script-package-preview-mobile.png');
  await page.locator('[data-package-close]').last().click();await page.setViewportSize({width:1440,height:1000});
  result.checks.push('file changes invalidate late responses; expired CSRF recovers; 390px dialog fits');
  await page.locator('#manage-script-search').fill('刻意不匹配');await page.locator('#manage-visible-filter').selectOption('visible');
  await openPackage();await checkFile(filename);await ready();await page.locator('#script-package-category').selectOption(first.categories[1].id);
  let imports=0,importWaiting=false;
  await page.route('**/api/script-packages/import',async route=>{
    imports++;importWaiting=true;await new Promise(resolve=>{release=resolve;});await route.continue();
  });
  await page.locator('#script-package-confirm').evaluate(button=>{button.click();button.click();});
  await until(()=>importWaiting,'import request in flight');
  assert(await page.locator('#script-package-file').isDisabled());assert(await page.locator('[data-package-close]').last().isDisabled());
  await page.keyboard.press('Escape');assert(await page.locator('#script-package-dialog').isVisible());
  release();release=null;await page.locator('#script-dialog').waitFor();await page.unroute('**/api/script-packages/import');
  assert.equal(imports,1);const after=await library();assert.equal(after.scripts.length,beforeCount+1);
  const imported=after.scripts.find(s=>s.title===packageTitle&&s.id!==source.id);assert(imported);
  assert.equal(imported.category_id,first.categories[1].id);assert.equal(imported.visible,false);
  assert.equal(await page.locator('#edit-script-id').inputValue(),imported.id);assert.equal(await page.locator('#manage-script-search').inputValue(),'');assert.equal(await page.locator('#manage-visible-filter').inputValue(),'');
  assert.deepEqual(after.scripts.find(s=>s.id===source.id),source);assert.deepEqual(await get('/api/state'),beforeState);
  assert.deepEqual(imported.blocks.map(b=>b.text),source.blocks.map(b=>b.text));assert(imported.blocks.every((b,i)=>b.id!==source.blocks[i].id));
  assert.equal(imported.media.sha256,source.media.sha256);assert.equal(imported.media.cues.length,1);
  assert.deepEqual(imported.media.cues[0].block_ids,imported.blocks.slice(0,2).map(b=>b.id));
  result.checks.push('one-click import creates a new hidden script with new IDs, correct cues, clears filters, opens editor; source/live unchanged');
  await page.locator('#script-dialog [data-close="script-dialog"]').first().click();
  await page.locator('#new-script').click();await page.locator('#open-import-editor').click();
  await page.locator('.import-ai-help > summary').click();
  const prompt=await page.locator('#import-ai-prompt').inputValue();assert.match(prompt,/保留原文顺序/);assert.match(prompt,/角色名后先写冒号/);assert.match(prompt,/缺少时不要编造/);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedPrompt=text;}}}));
  await page.locator('#copy-import-ai-prompt').click();await until(async()=>/已复制/.test(await page.locator('#import-ai-copy-status').textContent()),'copy prompt success');
  assert.equal(await page.evaluate(()=>window.__copiedPrompt),prompt);
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});document.execCommand=command=>{window.__compatCopy=command;return true;};});
  await page.locator('#copy-import-ai-prompt').click();assert.match(await page.locator('#import-ai-copy-status').textContent(),/已复制/);assert.equal(await page.evaluate(()=>window.__compatCopy),'copy');
  await page.evaluate(()=>{document.execCommand=()=>false;});
  await page.locator('#copy-import-ai-prompt').click();assert.match(await page.locator('#import-ai-copy-status').textContent(),/Ctrl\+C/);
  assert(await page.locator('#import-ai-prompt').evaluate(field=>field.readOnly&&field.selectionStart===0&&field.selectionEnd===field.value.length));
  const sample='标题：AI格式验收\n作者：原作者\n甲：（轻声）第一句\n甲：第二句\n\n（风声）\n乙：回应';
  await page.locator('#import-text').fill(sample);await page.locator('#import-analyze').click();await page.locator('#import-result').waitFor();
  await until(async()=>!await page.locator('#import-fill-editor').isDisabled(),'AI formatted preview');
  assert.equal(await page.locator('#import-source-text').textContent(),sample);
  assert.match(await page.locator('#import-warnings').textContent(),/跳过 1 个纯空行/);
  await screenshot('script-package-ai-prompt-desktop.png');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('script-package-ai-prompt-mobile.png');
  await page.locator('#import-fill-editor').click();await page.locator('#import-editor-dialog').waitFor({state:'hidden'});
  const draft=await page.evaluate(()=>window.piaEditor.getDraft());assert.equal(draft.blocks.length,6);assert.deepEqual(draft.blocks.map(b=>b.role),['','','甲','甲','','乙']);
  assert.equal(draft.blocks.map(b=>b.text).join(''),sample.replace('\n\n','\n'));
  await page.locator('#script-form button[type="submit"]').click();await page.locator('#script-dialog').waitFor({state:'hidden'});
  const saved=(await library()).scripts.find(s=>s.title==='AI格式验收');assert(saved);assert.deepEqual(saved.blocks.map(b=>b.text),draft.blocks.map(b=>b.text));assert.deepEqual(await get('/api/state'),beforeState);
  result.checks.push('AI prompt copies or selects for Ctrl+C; repeated roles, prompts and original nonempty text survive preview, draft and save');
  assert.deepEqual(result.page_errors,[]);result.passed=true;
} catch(error){result.error=error.stack;process.exitCode=1;if(page){result.ui_failure=await page.evaluate(()=>({error:document.querySelector('#script-package-error')?.textContent,status:document.querySelector('#script-package-status')?.textContent,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id)})).catch(()=>null);}}
finally {
  release?.();if(browser)await browser.close();
  if(child){try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});}catch(_){}child.kill();}
  fs.writeFileSync(path.join(output,'script-packages-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
})();
