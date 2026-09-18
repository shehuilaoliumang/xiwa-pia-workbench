const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','feedback-'+Date.now()),base='http://127.0.0.1:8892';
let browser,child;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let i=0;i<120;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
 child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8892','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
 await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'server');
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1600,height:1120}}),errors=[],writes=[];
 await context.addInitScript(()=>{window.lastPreviewPosition=null;window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='pia-preview-position')window.lastPreviewPosition=e.data})});
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const lib=async()=> (await context.request.get(base+'/api/library')).json();
 const state=async()=> (await context.request.get(base+'/api/state')).json();
 const send=async(p,body,method='POST')=>{const l=await lib();const r=await context.request.fetch(base+p,{method,data:body,headers:{'X-CSRF-Token':l.csrf_token}});assert(r.ok(),await r.text());return r.json()};
 const initial=await lib(),script=initial.scripts.find(s=>s.id==='script-01'),blocks=script.blocks;
 // This regression exercises continuous scrolling explicitly; new drafts default to pages.
 for(const orientation of ['portrait','landscape'])await send('/api/layouts',{orientation,layout:{body_mode:'scroll'}});
 await send('/api/queue',{script_ids:['script-01','script-02']},'PUT');
 await send('/api/apply',{mode:'list',list_source:'queue',script_ids:['script-01','script-02'],directory_level:'categories',focus_category_id:null,orientation:'portrait'});
 const original=await state();
 const page=await context.newPage();page.on('request',r=>{if(r.url().endsWith('/api/apply'))writes.push(r.postDataJSON())});
 await page.goto(base+'/control');
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
 await ready();await page.locator('#list-source').selectOption('queue');await ready();let frame=page.frames().find(f=>f.url().includes('preview=1'));
 const ext=a=>page.locator(`[data-preview-external="${a}"]`);
 const placement=page.locator('#preview-toolbar-placement'),feedback=page.locator('#preview-feedback-mode');
 assert.equal(await placement.inputValue(),'inside');assert.equal(await feedback.inputValue(),'confirm');
 await placement.selectOption('outside');
 await page.locator('#preview-external-tools').waitFor();
 assert.equal(await frame.locator('.preview-toolbar').isVisible(),false);
 const extBox=await ext('return-list').boundingBox(),applyBox=await page.locator('#apply-display').boundingBox();
 assert(Math.abs(extBox.y+extBox.height/2-applyBox.y-applyBox.height/2)<8,'external buttons should align with Apply');
 await frame.locator(`[data-preview-category="${script.category_id}"]`).click();await frame.locator('.stage-list').waitFor();await ready();
 assert.equal(await frame.locator('[data-preview-script]').count(),2,'category details retain the two-script queue scope');
 await frame.locator('[data-preview-script="script-01"]').click();await frame.locator('.stage-body').waitFor();await ready();
 await ext('next').click();assert.equal((await state()).revision,original.revision,'confirm mode must not publish');
 await ext('return-list').click();await frame.locator('.stage-list').waitFor();await ready();
 assert.equal((await state()).revision,original.revision);
 await frame.locator('[data-preview-script="script-01"]').click();await frame.locator('.stage-body').waitFor();await ready();
 // Switching from an already scrolling local preview must use its current position.
 await page.locator('#layout-speed').fill('180');await page.locator('#layout-speed').dispatchEvent('input');await ready();
 await ext('top').click();await ext('play').click();
 await frame.waitForFunction(()=>document.querySelector('#stage-scroll').scrollTop>650,null,{timeout:8000});
 await feedback.selectOption('realtime');
 await until(async()=> (await state()).mode==='script','enable realtime applies current preview');
 assert.notEqual((await state()).anchor,null,'entering realtime must refresh the current trial-scroll anchor');assert((await state()).playing);
 await ext('play').click();await until(async()=> !(await state()).playing,'pause after initial realtime sync');
 let snapshot=(await state()).snapshot.id;
 await frame.locator(`[data-anchor="${blocks[5].id}"]`).click();
 await until(async()=> (await state()).anchor===blocks[5].id,'direct selected paragraph sync');
 assert.equal((await state()).snapshot.id,snapshot,'same content must reuse audience snapshot');
 await ext('next').click();await until(async()=> (await state()).anchor===blocks[6].id,'external next sync');
 await ext('top').click();await until(async()=> (await state()).anchor===null,'top sync');
 await ext('play').click();await until(async()=> (await state()).playing,'play sync');
 await delay(350);await ext('play').click();await until(async()=> !(await state()).playing,'pause sync');
 assert.equal((await state()).snapshot.id,snapshot);

 // Manual wheel movement emits one semantic position after settling, not a write per animation frame.
 await frame.locator('#stage-scroll').hover({position:{x:180,y:240}});await page.mouse.wheel(0,680);
 await until(async()=>{const pos=await page.evaluate(()=>window.lastPreviewPosition);return pos?.reason==='interaction'&&pos.anchor!==null&&(await state()).anchor===pos.anchor},'wheel position sync');
 const font=Number(await page.locator('#layout-font').inputValue());
 await ext('font-larger').click();await until(async()=> (await state()).snapshot.layout.font_size===font+2,'font sync');
 await ready();
 await page.locator('[data-orientation=landscape]').click();await until(async()=> (await state()).orientation==='landscape','landscape sync');await ready();
 await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});
 await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa','browser','feedback-outside-desktop.png')});

 // The final selection must win even when a previous apply has not returned.
 let delayed=false,started=false;
 await page.route('**/api/apply',async route=>{if(!delayed){delayed=true;started=true;await delay(650)}await route.continue()});
 await frame.locator(`[data-anchor="${blocks[11].id}"]`).click();await until(()=>started,'delayed request began');
 await frame.locator(`[data-anchor="${blocks[14].id}"]`).click();
 await until(async()=> (await state()).anchor===blocks[14].id,'last selection survives in-flight apply');
 await delay(300);assert.equal((await state()).anchor,blocks[14].id);await page.unroute('**/api/apply');await ready();

 // A failed request from a previous feedback mode cannot discard the new mode's queued work.
 let rejectStarted=false,releaseRejection;
 const rejectionGate=new Promise(resolve=>{releaseRejection=resolve});
 await page.route('**/api/apply',async route=>{if(!rejectStarted){rejectStarted=true;await rejectionGate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'delayed old mode failure'})})}else await route.continue()});
 await frame.locator(`[data-anchor="${blocks[16].id}"]`).click();await until(()=>rejectStarted,'old mode request held');
 await feedback.selectOption('confirm');
 await frame.locator(`[data-anchor="${blocks[18].id}"]`).click();
 await until(async()=> (await page.evaluate(()=>window.lastPreviewPosition))?.anchor===blocks[18].id,'new mode selected position');
 await feedback.selectOption('realtime');releaseRejection();
 await until(async()=> (await state()).anchor===blocks[18].id,'new mode sync survives obsolete failure');await ready();await page.unroute('**/api/apply');

 await ext('return-list').click();await until(async()=>{const s=await state();return s.mode==='list'&&s.snapshot.directory_level==='scripts'&&s.snapshot.focus_category_id===script.category_id},'return to owning category sync');await ready();
 assert.deepEqual((await state()).snapshot.scripts.map(s=>s.id),['script-01','script-02'],'return keeps queue scope');
 await ext('return-list').click();await until(async()=> (await state()).snapshot.directory_level==='categories','return to category overview sync');await ready();
 // Preferences persist without refreshing the page overwriting or pausing the live state.
 await send('/api/command',{action:'play'});const beforeReload=await state();
 await page.reload();await ready();frame=page.frames().find(f=>f.url().includes('preview=1'));
 assert.equal(await placement.inputValue(),'outside');assert.equal(await feedback.inputValue(),'realtime');
 await delay(450);assert.equal((await state()).revision,beforeReload.revision);assert((await state()).playing);
 await feedback.selectOption('confirm');await page.locator('#list-source').selectOption('queue');await ready();const beforeConfirm=await state();
 await frame.locator(`[data-preview-category="${script.category_id}"]`).click();await frame.locator('.stage-list').waitFor();await ready();
 await frame.locator('[data-preview-script="script-01"]').click();await frame.locator('.stage-body').waitFor();await ready();await ext('next').click();await delay(400);
 assert.equal((await state()).revision,beforeConfirm.revision,'switching to confirmation stops subsequent sync');
 await page.locator('#apply-display').click();await until(async()=> (await state()).mode==='script','manual apply still works');assert(!(await state()).playing);

 // A stale preview cannot silently publish unseen content in realtime mode.
 await feedback.selectOption('realtime');await ready();await delay(250);
 await send('/api/scripts/script-01',{title:script.title+'（陈旧资料验证）'},'PATCH');
 const staleBefore=await state(),writesBefore=writes.length;
 await ext('next').click();
 await until(()=>writes.length>writesBefore,'stale apply attempted');await delay(1000);
 assert.equal((await state()).revision,staleBefore.revision);const staleAttempts=writes.length;
 await ext('next').click();await delay(500);assert.equal(writes.length,staleAttempts,'stale preview must stop automatic retry');
 await feedback.selectOption('confirm');
 await page.setViewportSize({width:390,height:844});await page.locator('#preview-external-tools').scrollIntoViewIfNeeded();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 for(const button of await page.locator('#preview-external-tools button:visible').all()){const box=await button.boundingBox();assert(box.x>=0&&box.x+box.width<=390)}
 await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa','browser','feedback-outside-mobile.png')});
 await placement.selectOption('inside');await page.locator('#preview-frame').hover({position:{x:30,y:30}});
 assert(await page.locator('#preview-external-tools').isHidden());assert(await frame.locator('.preview-toolbar').isVisible());
 await feedback.selectOption('realtime');await until(async()=> (await state()).snapshot.scripts[0].title.includes('陈旧资料验证'),'explicit realtime re-enable after source check');await ready();
 await page.locator('#preview-frame').hover({position:{x:30,y:30}});
 await frame.locator('[data-preview-action=top]').click();await until(async()=> (await state()).anchor===null,'inside toolbar realtime top');
 await frame.locator('[data-preview-action=next]').click();await until(async()=> (await state()).anchor===blocks[0].id,'inside toolbar realtime next');
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(root,'.qa','browser','feedback-result.json'),JSON.stringify({passed:true,browserErrors:errors,checks:['independent toolbar placement and feedback settings','desktop same-row and mobile fit','confirm isolation','realtime starts from current trial-scroll position','realtime navigation, selection, wheel, playback, font and orientation','same-content snapshot reuse','latest selection wins under delayed network','obsolete mode failure cannot discard newer sync','saved preferences and reload isolation','return to confirm','stale preview stops automatic sync']},null,2));
 console.log('Feedback browser acceptance passed: toolbar placement, realtime feedback, ordered sync, reload isolation, stale preview guard and responsive layout.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill()});
