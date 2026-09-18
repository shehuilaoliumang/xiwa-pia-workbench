const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','hierarchy-regression',String(Date.now()));
const base=process.argv[2]||'http://127.0.0.1:8879';
if(new URL(base).port==='8765')throw Error('Browser regression must not use the formal instance.');
let browser,child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
 if(!process.argv[2]){
   child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8879','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
   let up=false;for(let i=0;i<120;i++){try{up=(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{}if(up)break;await delay(100)}assert(up,'isolated interactive server did not start');
 }
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1050}}),errors=[],previewWrites=[];
 await context.addInitScript(()=>{
   window.observedTransitions=[];
   const original=Element.prototype.animate;
   Element.prototype.animate=function(frames,options){window.observedTransitions.push({id:this.id,duration:options?.duration});return original.call(this,frames,options)};
 });
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const lib=async()=> (await context.request.get(base+'/api/library')).json();
 const state=async()=> (await context.request.get(base+'/api/state')).json();
 const send=async(path,data,method='POST')=>{const l=await lib();const r=await context.request.fetch(base+path,{method,data,headers:{'X-CSRF-Token':l.csrf_token}});assert(r.ok(),await r.text());return r.json()};
 const initial=await lib(),ids=['script-01','script-02','script-08'];
 // This regression exercises continuous scrolling explicitly; new drafts default to pages.
 for(const orientation of ['portrait','landscape'])await send('/api/layouts',{orientation,layout:{body_mode:'scroll'}});
 await send('/api/queue',{script_ids:ids},'PUT');
 await send('/api/apply',{mode:'list',list_source:'queue',script_ids:ids,directory_level:'categories',focus_category_id:null,orientation:'portrait'});
 await send('/api/command',{action:'play'});
 const before=await state(),page=await context.newPage();
 await page.goto(base+'/control');
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
 await ready();await page.locator('#list-source').selectOption('queue');await ready();
 const frame=page.frames().find(f=>f.url().includes('preview=1'));
 assert(frame);
 page.on('request',r=>{if(r.frame()===frame&&r.method()!=='GET')previewWrites.push(r.url())});
 const tool=a=>frame.locator(`[data-preview-action="${a}"]`);
 const hover=()=>page.locator('#preview-frame').hover({position:{x:30,y:30}});
 // A tall preview can extend below the page viewport. Scroll its real ancestor
 // to the iframe bottom before using the inside toolbar; never force a click.
 const toolbarAccess=[];
 const clickTool=async action=>{
   const before=await tool(action).boundingBox();
   await page.locator('#preview-frame').evaluate(element=>element.scrollIntoView({block:'end',inline:'nearest'}));
   const frameBox=await page.locator('#preview-frame').boundingBox(),height=page.viewportSize().height;
   // Scrolling can leave the pointer outside the iframe; entering it reveals hover-only controls.
   await page.mouse.move(frameBox.x+30,Math.min(height-30,frameBox.y+frameBox.height-30));
   await frame.waitForFunction(()=>getComputedStyle(document.querySelector('.preview-toolbar')).pointerEvents==='auto');
   await tool(action).hover();
   const after=await tool(action).boundingBox(),viewport=page.viewportSize();
   assert(after&&after.y>=0&&after.y+after.height<=viewport.height,'inside toolbar is reachable by normal page scrolling');
   if(!toolbarAccess.length)toolbarAccess.push({action,before,after,viewport});
   await tool(action).click();
 };
 const fits=async()=>{const toolBox=await frame.locator('.preview-toolbar').boundingBox(),area=await page.locator('.preview-surround').boundingBox();assert(toolBox.x>=area.x);assert(toolBox.x+toolBox.width<=area.x+area.width+1);assert(toolBox.y+toolBox.height<=area.y+area.height,'toolbar must not be clipped by its surround')};
 const ownerCategory=initial.scripts.find(s=>s.id==='script-01').category_id,otherCategory=initial.scripts.find(s=>s.id==='script-08').category_id;
 const enterOwner=async()=>{if(await frame.locator(`[data-preview-category="${ownerCategory}"]`).count()){await frame.locator(`[data-preview-category="${ownerCategory}"]`).click();await frame.locator('.stage-list').waitFor();await ready();}};
 const open=async()=>{await enterOwner();await frame.locator('[data-preview-script="script-01"]').click();await frame.locator('.stage-body').waitFor();await ready()};
 const unchanged=async()=>{const s=await state();assert.equal(s.revision,before.revision);assert.equal(s.snapshot.id,before.snapshot.id);assert(s.playing)};
 assert.equal(await frame.locator('[data-preview-script]').count(),0,'category overview is the first directory level');
 assert.equal(await frame.locator('[data-preview-category]').count(),2,'queue overview includes both represented categories');
 await open();await unchanged();
 assert.equal(await page.locator('#control-script').inputValue(),'script-01');
 await hover();assert.equal(await frame.locator('.preview-toolbar').evaluate(e=>getComputedStyle(e).pointerEvents),'auto');
 await clickTool('return-list');await frame.locator('.stage-list').waitFor();await ready();
 assert.equal(await frame.locator('[data-preview-script]').count(),2,'body returns to its category, retaining queue filtering');
 assert.deepEqual(await frame.locator('[data-preview-script]').evaluateAll(nodes=>nodes.map(node=>node.dataset.previewScript)),['script-01','script-02']);
 assert.equal(await page.locator('#list-source').inputValue(),'queue');await unchanged();
 await clickTool('return-list');await frame.locator('[data-preview-category]').first().waitFor();await ready();
 assert.equal(await frame.locator('[data-preview-category]').count(),2);await unchanged();
 await frame.locator(`[data-preview-category="${otherCategory}"]`).click();await frame.locator('.stage-list').waitFor();await ready();
 assert.deepEqual(await frame.locator('[data-preview-script]').evaluateAll(nodes=>nodes.map(node=>node.dataset.previewScript)),['script-08'],'other queued category remains reachable without out-of-queue scripts');
 await clickTool('return-list');await frame.locator('[data-preview-category]').first().waitFor();await ready();await unchanged();
 await open();await hover();
 const blocks=initial.scripts.find(s=>s.id==='script-01').blocks;
 await frame.locator(`[data-anchor="${blocks[4].id}"]`).click();
 assert.equal(await frame.locator('.preview-selected').getAttribute('data-anchor'),blocks[4].id);
 await clickTool('next');assert.equal(await frame.locator('.preview-selected').getAttribute('data-anchor'),blocks[5].id);
 await clickTool('previous');assert.equal(await frame.locator('.preview-selected').getAttribute('data-anchor'),blocks[4].id);
 const font=Number(await page.locator('#layout-font').inputValue());
 await clickTool('font-larger');await page.waitForFunction(n=>Number(document.querySelector('#layout-font').value)===n,font+2);await ready();assert.equal(Number(await page.locator('#layout-font').inputValue()),font+2);
 assert.equal(await frame.locator('.preview-selected').getAttribute('data-anchor'),blocks[4].id);
 await hover();await clickTool('top');assert.equal(await frame.locator('.preview-selected').count(),0);
 await clickTool('play');await page.waitForTimeout(650);
 assert((await frame.locator('#stage-scroll').evaluate(e=>e.scrollTop))>0);
 await clickTool('play');await unchanged();
 await frame.locator(`[data-anchor="${blocks[8].id}"]`).click();await clickTool('apply');
 await page.waitForFunction(()=>document.querySelector('#live-description').textContent.includes('万有引力'));
 let applied=await state();assert.equal(applied.mode,'script');assert.equal(applied.anchor,blocks[8].id);assert.equal(applied.playing,false);
 assert.deepEqual(previewWrites,[],'preview must never connect or write live state itself');
 // Both apply buttons use the selected preview anchor, including bottom clamping.
 await frame.locator(`[data-anchor="${blocks.at(-1).id}"]`).click();await page.locator('#apply-display').click();
 await page.waitForTimeout(300);applied=await state();assert.equal(applied.anchor,blocks.at(-1).id);
 assert((await frame.evaluate(()=>window.observedTransitions.filter(a=>a.duration===270).length))>=3);
 assert.equal(await frame.locator('#stage-content').evaluate(e=>getComputedStyle(e).opacity),'1');
 await hover();await fits();await fs.mkdir('.qa/browser',{recursive:true});await page.locator('.preview-panel').screenshot({path:'.qa/browser/interactive-control.png'});

 await page.locator('[data-orientation=landscape]').click();await ready();await hover();await fits();
 assert(await frame.locator('#stage.landscape').count());
 await clickTool('return-list');await frame.locator('.stage-list').waitFor();await ready();
 await open();await hover();await fits();
 await page.locator('.preview-panel').screenshot({path:'.qa/browser/interactive-landscape.png'});
 await page.locator('[data-orientation=portrait]').click();await ready();
 const display=await context.newPage();await display.goto(base+'/display');await display.locator('.stage-body').waitFor();
 assert.equal(await display.locator('.preview-toolbar').count(),0);
 await page.bringToFront();await hover();
 await clickTool('return-list');await frame.locator('.stage-list').waitFor();await ready();await clickTool('apply');
 await display.bringToFront();await display.locator('.stage-list').waitFor();await display.waitForFunction(()=>getComputedStyle(document.querySelector('#stage-content')).opacity==='1');
 assert((await display.evaluate(()=>window.observedTransitions.filter(a=>a.duration===270).length))>=1);
 assert.equal(await display.locator('#stage-content').evaluate(e=>getComputedStyle(e).opacity),'1');
 assert(!/PPT\s*第?\s*\d|来源页|第\s*\d+\s*页/i.test(await display.locator('body').innerText()));
 await display.close();

 // Notes are a view-only cleanup: untouched imported notes survive an edit.
 const manage=await context.newPage();await manage.goto(base+'/manage');
 const original=initial.scripts.find(s=>s.id==='script-01');
 await manage.locator('[data-edit-script="script-01"]').click();
 assert(!/\bp\d+|SRC-\d+/.test(await manage.locator('#edit-notes').inputValue()));
 await manage.locator('#edit-title').fill(original.title+'（交互验收）');
 await manage.locator('#script-form button[type=submit]').click();await manage.locator('#script-dialog').waitFor({state:'hidden'});
 let saved=(await lib()).scripts.find(s=>s.id===original.id);
 assert.equal(saved.notes,original.notes);assert.deepEqual(saved.source_pages,original.source_pages);assert.deepEqual(saved.blocks,original.blocks);
 await send('/api/scripts/'+original.id,{title:original.title},'PATCH');
 // Inspect all 14 reader records, including expanded source notes and image labels.
 for(const script of initial.scripts){
   await manage.goto(base+'/script/'+script.id);await manage.locator('#reader-notes').waitFor({state:'attached'});
   await manage.locator('.reader-details').evaluate(e=>e.open=true);
   const text=await manage.locator('body').innerText();
   assert(!/\bp\d+|SRC-\d+|来源页|第\s*\d+\s*页|PPT\s*[·:：]?\s*\d/.test(text),'source locator exposed: '+script.id);
 }
 // Normal page links retain navigation and restore visibility after Back.
 await manage.goto(base+'/');await manage.locator(`[data-open-category="${ownerCategory}"]`).click();await manage.locator('.card-title a').first().click();await manage.waitForURL('**/script/*');
 await manage.locator('.breadcrumb a').click();await manage.waitForURL(base+'/?category='+encodeURIComponent(ownerCategory));await manage.waitForTimeout(300);
 assert.equal(await manage.locator('.script-card').count(),initial.scripts.filter(script=>script.category_id===ownerCategory).length,'reader returns to complete category');
 await manage.locator('#catalog-back').click();assert(await manage.locator(`[data-open-category="${ownerCategory}"]`).isVisible());
 assert.equal(await manage.locator('.workspace').evaluate(e=>getComputedStyle(e).opacity),'1');
 await manage.goBack();await manage.waitForTimeout(350);assert.equal(await manage.locator('.workspace').evaluate(e=>getComputedStyle(e).opacity),'1');

 await page.bringToFront();await page.emulateMedia({reducedMotion:'reduce'});await hover();
 const animations=await frame.evaluate(()=>window.observedTransitions.length);
 await frame.locator('[data-preview-script="script-01"]').click();await frame.locator('.stage-body').waitFor();await ready();
 assert.equal(await frame.evaluate(()=>window.observedTransitions.length),animations,'reduced motion must skip transitions');
 await page.setViewportSize({width:390,height:844});await hover();await page.waitForTimeout(250);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const box=await frame.locator('.preview-toolbar').boundingBox(),frameBox=await page.locator('#preview-frame').boundingBox();
 assert(box.width<=frameBox.width);assert(box.x>=frameBox.x);assert(box.x+box.width<=frameBox.x+frameBox.width+1);
 await fits();await page.locator('.preview-panel').screenshot({path:'.qa/browser/interactive-mobile.png'});
 assert.deepEqual(errors,[]);
 await fs.writeFile('.qa/browser/interactive-result.json',JSON.stringify({passed:true,browserErrors:errors,previewWrites,toolbarAccess,checks:['two-level category navigation and retained queue scope','hover toolbar','paragraph previous next top','local trial scroll','font retains selection','draft isolation while live playing','both apply buttons preserve anchors','bottom paragraph selection','audience transition without controls','all source page labels hidden','unmodified raw notes and blocks preserved','page navigation and Back','reduced motion','portrait and landscape toolbar fit','mobile fit']},null,2));
 console.log('Interactive browser acceptance passed: direct preview, isolated scrolling, selected-anchor apply, transitions, source display cleanup and source preservation, mobile fit.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(child){try{stop()}catch{}if(child.exitCode===null)child.kill()}});
