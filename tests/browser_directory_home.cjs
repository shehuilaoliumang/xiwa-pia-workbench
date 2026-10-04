const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','directory-home-'+Date.now()),base='http://127.0.0.1:8879';
let browser,child; let startupOutput="",lastHealth;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
(async()=>{
 child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8879','--data-dir',data],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>startupOutput+=chunk);child.stderr.on('data',chunk=>startupOutput+=chunk);
 await until(async()=>{try{lastHealth=await(await fetch(base+'/api/health')).json();return lastHealth.data_dir===data}catch(error){lastHealth=String(error);return false}},'isolated server');
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1050}}),errors=[];
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 await context.addInitScript(()=>{addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='wb-preview')window.observedDirectorySnapshot=e.data.snapshot})});
 const lib=async()=>(await context.request.get(base+'/api/library')).json();
 const state=async()=>(await context.request.get(base+'/api/state')).json();
 const send=async(url,body,method='POST')=>{const l=await lib(),r=await context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':l.csrf_token}});assert(r.ok(),await r.text());return r.json()};
 const library=await lib(),script=library.scripts.find(s=>s.id==='script-01'),other=library.scripts.find(s=>s.id==='script-08');
 await send('/api/apply',{mode:'script',script_id:other.id,orientation:'portrait',layout:{body_mode:'scroll'}});
 await send('/api/command',{action:'play'});
 const baseline=await state(),page=await context.newPage();let frame;
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
 const visit=async url=>{await page.goto(base+url);await ready();frame=page.frames().find(f=>f.url().includes('preview=1'))};
 const snapshot=()=>frame.evaluate(()=>window.observedDirectorySnapshot);
 const home=async()=>{
  await page.locator('[data-mode="list"]').click();await ready();
  await until(async()=>{const s=await snapshot();return s?.mode==='list'&&s.directory_level==='categories'&&s.focus_category_id===null},'category home');
  assert.equal(await frame.locator('[data-preview-script]').count(),0);
 };
 const open=async()=>{
  await frame.locator(`[data-preview-category="${script.category_id}"]`).click();await ready();
  await frame.locator(`[data-preview-script="${script.id}"]`).click();await ready();
  await frame.locator('.stage-body').waitFor();
 };
 const isolated=async()=>{const live=await state();assert.equal(live.revision,baseline.revision);assert.equal(live.snapshot.id,baseline.snapshot.id);assert(live.playing)};
 await visit('/control?script='+script.id);await home();
 assert((await frame.locator('[data-preview-category]').count())>=6);await isolated();
 // The top-level mode button differs from the preview Back button.
 await open();await page.locator('#preview-toolbar-placement').selectOption('outside');
 await page.locator('[data-preview-external="return-list"]').click();await ready();await frame.locator('.stage-list').waitFor();
 assert.equal((await snapshot()).focus_category_id,script.category_id);
 await home();await isolated();
 // Returning home preserves an explicitly selected category range.
 await page.locator('#control-categories input').evaluateAll((nodes,id)=>nodes.forEach(n=>{n.checked=n.value===id}),script.category_id);
 await page.locator('#control-categories input').first().dispatchEvent('change');await ready();
 await open();await home();assert.deepEqual((await snapshot()).categories.map(c=>c.id),[script.category_id]);await isolated();
 // Queue mode returns to its own overview, including when body selection is outside that queue.
 await send('/api/queue',{script_ids:[script.id,other.id]},'PUT');await visit('/control');
 await page.locator('#list-source').selectOption('queue');await ready();await open();await home();
 assert.equal(await page.locator('#list-source').inputValue(),'queue');assert.equal(await frame.locator('[data-preview-category]').count(),2);
 await page.locator('[data-mode="script"]').click();await ready();
 const outside=library.scripts.find(s=>![script.id,other.id].includes(s.id));
 await page.locator('#control-script').selectOption(outside.id);await ready();await home();
 assert.equal(await page.locator('#list-source').inputValue(),'queue');assert.equal(await frame.locator('[data-preview-category]').count(),2);await isolated();
 await send('/api/queue',{script_ids:[]},'PUT');await visit('/control?script='+script.id);
 await page.locator('[data-mode="list"]').click();await ready();await page.locator('#list-source').selectOption('queue');await ready();
 await page.locator('[data-mode="script"]').click();await ready();await home();
 assert.equal(await frame.locator('[data-preview-category]').count(),0);assert.equal((await snapshot()).scripts.length,0);await isolated();
 // Explicit realtime navigation publishes the root once it is rendered and verified.
 await visit('/control?script='+script.id);await page.locator('#layout-body-mode').selectOption('pages');await ready();
 await page.locator('#preview-feedback-mode').selectOption('realtime');
 await until(async()=>{const s=await state();return s.mode==='script'&&s.snapshot.layout.body_mode==='pages'},'realtime paged body');
 await home();await until(async()=>{const s=await state();return s.mode==='list'&&s.snapshot.directory_level==='categories'&&s.snapshot.focus_category_id===null},'realtime category home');
 assert.deepEqual(errors,[]);
 await fs.mkdir(path.join(root,'.qa/browser'),{recursive:true});
 await fs.writeFile(path.join(root,'.qa/browser/directory-home-result.json'),JSON.stringify({passed:true,browserErrors:errors,checks:['explicit script entry to directory home','preview Back stays one level','category range retained','queue range retained including body outside queue','empty queue stays empty','confirmation leaves playing live unchanged','realtime paged body to category home']},null,2));
 console.log('Directory home acceptance passed: top-level mode, scoped root, one-level preview Back and confirmation/realtime isolation.');
})().catch(e=>{console.error(e);if(startupOutput)console.error(startupOutput);console.error({expectedData:data,lastHealth});process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(child){try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{}if(child.exitCode===null)child.kill()}});
