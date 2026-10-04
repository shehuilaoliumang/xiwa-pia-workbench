'use strict';
// Actual Electron renderer at native page zoom, using a read-only copy of local data.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const {_electron: electron} = require('playwright');
const root = path.resolve(__dirname, '..'), python = path.join(root, 'runtime', 'python.exe');
const data = path.join(root, '.qa', 'desktop-editor-preview-' + Date.now());
const output = path.join(root, '.qa', 'editor-preview-fit-20260930');
const base = 'http://127.0.0.1:8939';
let child, app, page, focusAnchor = null;
const result = {passed: false, errors: [], checks: [], measurements: [], screenshots: [], data_dir: data};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(100); } throw Error('Timed out: ' + label); }
async function get(endpoint) { const r = await fetch(base + endpoint); const body = await r.json(); assert(r.ok, JSON.stringify(body)); return body; }
async function ready() {
  // An orientation change can briefly keep the previous success label before
  // its change event and iframe layout finish. Require a stable settled page,
  // including agreement between the parent pager and the actual iframe page.
  await delay(200);
  let stable = 0;
  await until(async () => {
    const settled = await page.evaluate(anchor => {
      const doc = document.querySelector('#editor-preview-frame').contentDocument;
      const pages = [...doc.querySelectorAll('.stage-page')];
      const current = pages.findIndex(node => node.classList.contains('is-current'));
      const pager = document.querySelector('#editor-preview-page').textContent;
      return document.querySelector('#editor-preview-status').textContent.includes('已更新到当前草稿') &&
        current >= 0 && pager === `${current + 1} / ${pages.length} 页` &&
        (!anchor || [...pages[current].querySelectorAll('.preview-selected[data-anchor]')].some(node => node.dataset.anchor === anchor));
    }, focusAnchor);
    stable = settled ? stable + 1 : 0;
    return stable >= 5;
  }, 'settled render with matching page counter');
}
async function bounds(label) {
  await ready();
  await delay(250);
  const sample = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
    return {window:{width:innerWidth,height:innerHeight},dialog:rect('#script-dialog'),panel:rect('#editor-preview-panel'),slot:rect('.editor-preview-stage-slot'),
      frame:rect('#editor-preview-frame'),nav:rect('.editor-preview-navigation'),footer:rect('#script-form > .dialog-actions'),
      pane:rect('.editor-edit-pane'),outer_scroll:document.querySelector('#script-dialog').scrollTop};
  });
  const inside = (child, parent, label) => assert(child.x >= parent.x - 2 && child.y >= parent.y - 2 && child.right <= parent.right + 2 && child.bottom <= parent.bottom + 2, label + ': ' + JSON.stringify(sample));
  inside(sample.dialog,{x:0,y:0,right:sample.window.width,bottom:sample.window.height},'dialog in viewport');
  inside(sample.frame,sample.slot,'complete canvas in stage slot');
  inside(sample.slot,sample.panel,'slot in preview');
  inside(sample.nav,sample.panel,'pager in preview');
  inside(sample.panel,sample.dialog,'preview in dialog');
  inside(sample.footer,sample.dialog,'save/cancel visible');
  assert(sample.frame.height > 100 && sample.frame.width > 80, 'nonzero readable canvas');
  assert.equal(sample.outer_scroll, 0, 'outer dialog never scrolls in split mode');
  result.measurements.push({label,...sample});
}
async function shot(name) {
  const target = path.join(output, name);
  // A hidden native window may supply its previously painted surface on the
  // first capture, even when its DOM has already settled. Wake its compositor
  // and require consecutive stable captures before saving visual evidence.
  let png, previousHash, stable = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    png = await app.evaluate(async ({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/manage'));
      return (await window.webContents.capturePage(undefined, {stayHidden:true,stayAwake:true})).toPNG().toString('base64');
    });
    const hash = crypto.createHash('sha256').update(Buffer.from(png,'base64')).digest('hex');
    stable = hash === previousHash ? stable + 1 : 0;
    previousHash = hash;
    if (attempt >= 2 && stable >= 2) break;
    await delay(150);
  }
  assert(stable >= 2, 'native compositor capture is stable');
  await ready();
  assert(png.length > 1000, 'native renderer capture contains pixels');
  await fs.writeFile(target, Buffer.from(png, 'base64')); result.screenshots.push(target);
}
async function resize(width,height,zoom) {
  await app.evaluate(({BrowserWindow},{width,height,zoom}) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/manage')); w.setContentSize(width,height); w.webContents.setZoomFactor(zoom); }, {width,height,zoom});
}
(async () => {
  await fs.mkdir(output,{recursive:true});
  let occupied=false;try{await fetch(base+'/api/health');occupied=true;}catch{}
  assert(!occupied,'Do not reuse an occupied QA service');
  execFileSync(python,['-X','utf8','-c',[
    'import sys,sqlite3,pathlib,shutil',
    'source=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2]);target.mkdir(parents=True)',
    "c=sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True);d=sqlite3.connect(target/'workbench.sqlite3');c.backup(d);d.close();c.close()",
    "media=source.parent/'media'",
    "if media.exists():shutil.copytree(media,target/'media')"
  ].join('\n'),path.join(root,'instance','workbench.sqlite3'),data],{cwd:root,windowsHide:true});
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8939','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return path.resolve((await get('/api/health')).data_dir)===data}catch{return false}},'isolated server');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.join(root,'desktop','runtime','electron.exe'),args:[path.join(root,'desktop','main.cjs'),'--url='+base+'/','--data-dir='+data,'--diagnostics','--no-show'],cwd:root,env,timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>result.errors.push(error.message));
  await page.goto(base+'/manage');await page.waitForFunction(()=>!!window.wbEditorTools);
  // Keep the editor focus and selection intact; suppress only caret blinking
  // during pixel comparison so an otherwise settled frame can be stable.
  await page.addStyleTag({content:'input,textarea{caret-color:transparent!important}'});
  const beforeLibrary=await get('/api/library'),beforeState=await get('/api/state');
  const long=beforeLibrary.scripts.find(script=>script.title.includes('万有引力'));assert(long&&long.blocks.length>=50);
  result.script_id=long.id;result.block_count=long.blocks.length;
  await resize(1440,900,1);
  await page.locator(`[data-edit-script="${long.id}"]`).click();
  await page.locator('#body-editor-details').evaluate(e=>{e.open=true});
  await page.locator('#editor-preview-panel').evaluate(e=>{e.open=true});await ready();
  await bounds('desktop 1440x900 top');await shot('desktop-editor-fit-top.png');
  const last=long.blocks.filter(b=>b.kind==='text'&&b.text.trim()).at(-1);
  focusAnchor=last.id;
  await page.locator(`.body-editor-row[data-block-id="${last.id}"] textarea`).focus();
  const frame=page.frameLocator('#editor-preview-frame');
  await until(async()=>await frame.locator(`.stage-page.is-current .preview-selected[data-anchor="${last.id}"]`).count()>0,'editing last sentence focuses last page');
  await bounds('desktop 1440x900 last sentence');await shot('desktop-editor-fit-last.png');
  result.checks.push('Current local long script at top and last sentence: independent left scroll, complete right page, visible save/footer');
  await resize(1440,900,1.25);await bounds('desktop 1440x900 zoom125');await shot('desktop-editor-fit-125.png');
  await resize(1280,720,1.25);await bounds('desktop 1280x720 zoom125');await shot('desktop-editor-fit-low-125.png');
  result.checks.push('Actual Electron 125% zoom fits complete page and controls at both standard and low window heights');
  await page.locator('#editor-preview-orientation').selectOption('landscape');await ready();await bounds('desktop landscape low zoom125');await shot('desktop-editor-fit-landscape.png');
  await page.locator('#editor-preview-zoom').click();await ready();await bounds('desktop landscape enlarged low zoom125');
  await page.locator('#editor-preview-orientation').selectOption('portrait');await ready();await bounds('desktop portrait enlarged low zoom125');await shot('desktop-editor-fit-enlarged.png');
  result.checks.push('Portrait/landscape and enlarged preview stay inside the visible window without clipping');
  assert.deepEqual(await get('/api/library'),beforeLibrary,'editing focus and fit do not save data');
  assert.deepEqual(await get('/api/state'),beforeState,'editing focus and fit do not alter the live snapshot');
  assert.deepEqual(result.errors,[]);result.passed=true;
  console.log('Real Electron editor preview passed ('+result.checks.length+' groups, '+result.measurements.length+' layouts).');
})().catch(error=>{result.failure=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{
  if(page&&!result.passed)try{await shot('desktop-editor-fit-failure.png')}catch{}
  if(app)await app.close();
  if(child)try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{if(child.exitCode===null)child.kill()}
  await fs.writeFile(path.join(output,'desktop-result.json'),JSON.stringify(result,null,2));
});
