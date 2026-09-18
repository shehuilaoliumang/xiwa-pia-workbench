const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','category-select-all-'+Date.now()),base='http://127.0.0.1:8907',evidence=path.join(root,'.qa/browser');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<180;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
let browser,child,page;const errors=[],checks=[];
(async()=>{
 await fs.mkdir(evidence,{recursive:true});
 child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8907','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
 await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
 const library=async()=>(await context.request.get(base+'/api/library')).json(),state=async()=>(await context.request.get(base+'/api/state')).json();
 const send=async(url,body,method='PATCH')=>{const lib=await library(),response=await context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':lib.csrf_token}});assert(response.ok(),await response.text());return response.json()};
 const initialLib=await library(),visibleCategories=initialLib.categories.filter(category=>category.visible!==false&&(category.id!=='uncategorized'||initialLib.scripts.some(script=>script.category_id===category.id&&script.visible!==false)));
 page=await context.newPage();const calls=[];
 page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(request.method()==='POST'&&['/api/preview','/api/apply'].includes(pathname))calls.push({path:pathname,body:request.postDataJSON()})});
 await page.goto(base+'/control');
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);await ready();
 let frame=page.frames().find(item=>item.url().includes('preview=1'));
 const button=page.locator('#control-select-all-categories'),actions=page.locator('#control-category-actions'),count=page.locator('#control-category-count');
 const boxes=()=>page.locator('#control-categories input[type=checkbox]'),checked=()=>page.locator('#control-categories input:checked').count();
 const readCount=async(selected,total)=>assert.match(await count.textContent(),new RegExp('已选 '+selected+' / '+total));
 const liveInitial=await state();assert.equal(await boxes().count(),visibleCategories.length);assert.equal(await checked(),visibleCategories.length);await readCount(visibleCategories.length,visibleCategories.length);
 assert.equal(await page.locator('#control-categories #control-select-all-categories').count(),0,'action is outside checkbox query region');assert.equal(await button.isDisabled(),false);
 let beforeCalls=calls.length;await button.click();await delay(400);assert.equal(calls.length,beforeCalls,'already-all overview click does not request preview/apply');assert.deepEqual(await state(),liveInitial);
 checks.push('initial all checked; explicit count; separate action container; already-all no-op');

 await boxes().first().uncheck();await ready();await readCount(visibleCategories.length-1,visibleCategories.length);assert.equal(await frame.locator('[data-preview-category]').count(),visibleCategories.length-1);
 beforeCalls=calls.length;await button.click();await ready();await readCount(visibleCategories.length,visibleCategories.length);assert.equal(await checked(),visibleCategories.length);assert.equal(await frame.locator('[data-preview-category]').count(),visibleCategories.length);
 assert.equal(calls.slice(beforeCalls).filter(call=>call.path==='/api/preview').length,1);assert.equal(calls.slice(beforeCalls).filter(call=>call.path==='/api/apply').length,0);assert.deepEqual(await state(),liveInitial);
 const populated=visibleCategories.find(category=>initialLib.scripts.some(script=>script.category_id===category.id&&script.visible!==false));
 await frame.locator('[data-preview-category="'+populated.id+'"]').click();await ready();await frame.locator('[data-preview-script]').first().waitFor();
 await button.click();await ready();assert.equal(await frame.locator('[data-preview-category]').count(),visibleCategories.length,'all selection returns from a focused category to overview');assert.match(await page.locator('#directory-path').textContent(),/分类总览 → 分类内剧本/);
 checks.push('partial selection expands to every visible category without publishing; nested directory returns to category overview');

 for(const checkbox of await boxes().all())await checkbox.uncheck();await ready();assert.equal(await checked(),0);await readCount(0,visibleCategories.length);assert.match(await count.textContent(),/默认全部/);
 assert.equal(await frame.locator('[data-preview-category]').count(),visibleCategories.length,'zero checked retains existing all-category compatibility');
 await button.click();await ready();assert.equal(await checked(),visibleCategories.length);
 await page.locator('#list-source').selectOption('queue');await ready();assert.equal(await actions.isVisible(),false);assert.equal(await page.locator('#control-categories').isVisible(),false);assert.equal(await frame.locator('[data-preview-category]').count(),0,'empty queue remains empty');
 await page.locator('#list-source').selectOption('categories');await ready();assert(await actions.isVisible());
 await page.locator('button[data-mode="script"]').click();await ready();assert.equal(await actions.isVisible(),false);await page.locator('button[data-mode="list"]').click();await ready();assert(await actions.isVisible());
 assert.deepEqual(await state(),liveInitial);checks.push('zero-check compatibility clear; queue and body modes hide category actions; confirm preview remains isolated');

 await page.locator('#preview-feedback-mode').selectOption('realtime');await until(async()=> (await state()).snapshot?.directory_level==='categories','realtime initial overview');await ready();
 await boxes().first().uncheck();await ready();await until(async()=> (await state()).snapshot.categories.length===visibleCategories.length-1,'realtime partial scope');
 await button.click();await ready();await until(async()=> (await state()).snapshot.categories.length===visibleCategories.length,'realtime full scope');
 const allLive=await state();assert.equal(allLive.snapshot.selection.category_ids.length,visibleCategories.length);assert.equal(allLive.snapshot.directory_level,'categories');
 beforeCalls=calls.length;await button.click();await button.click();await delay(450);assert.equal(calls.length,beforeCalls,'repeated all click in realtime emits nothing');assert.deepEqual(await state(),allLive);
 await page.locator('#preview-feedback-mode').selectOption('confirm');checks.push('realtime full selection applies correctly; repeated all selection never republishes');

 const added=await send('/api/categories',{name:'新增很长的分类名称用于验证窄屏排列与全选同步',visible:true,color:'#725B3E'},'POST');
 await until(async()=>await boxes().count()===visibleCategories.length+1,'passive library refresh sees new category');await ready();await readCount(visibleCategories.length,visibleCategories.length+1);
 assert.equal(await page.locator('#control-categories input[value="'+added.id+'"]').isChecked(),false);await button.click();await ready();assert.equal(await checked(),visibleCategories.length+1);
 await send('/api/categories/'+populated.id,{visible:false});await until(async()=>await boxes().count()===visibleCategories.length,'hidden category disappears');await ready();await readCount(visibleCategories.length,visibleCategories.length);
 assert.equal(await page.locator('#control-categories input[value="'+populated.id+'"]').count(),0);
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});await button.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at '+width);const rect=await button.boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width+1&&rect.height>=36,'all button reachable at '+width)}
 await page.setViewportSize({width:1440,height:900});await page.locator('.prepare-panel').screenshot({path:path.join(evidence,'category-select-all-desktop.png')});await page.setViewportSize({width:390,height:844});await page.locator('.prepare-panel').screenshot({path:path.join(evidence,'category-select-all-mobile.png')});
 checks.push('new/hidden categories update counts after maintenance refresh; long labels and action fit desktop/390/320');

 const current=await library();for(const category of current.categories.filter(item=>item.id!=='uncategorized'&&item.visible!==false))await send('/api/categories/'+category.id,{visible:false});
 await until(async()=>await boxes().count()===0,'no visible categories');await ready();assert(await button.isDisabled());assert.match(await count.textContent(),/暂无可见分类/);assert.equal(await frame.locator('[data-preview-category]').count(),0);
 assert.deepEqual(await state(),allLive,'maintenance and confirmation full-select did not replace frozen live state');
 await send('/api/categories/'+added.id,{visible:true});await until(async()=>await boxes().count()===1,'visible category restored');await ready();assert.equal(await button.isDisabled(),false);await readCount(0,1);await button.click();await ready();await readCount(1,1);
 await page.reload();await ready();assert.equal(await checked(),1);await readCount(1,1);assert.deepEqual(await state(),allLive);
 checks.push('zero-category button disabled; restore reenables; refresh starts with visible categories selected without publishing');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(evidence,'category-select-all-result.json'),JSON.stringify({passed:true,errors,checks},null,2));console.log('Category select all passed: '+checks.join('; '));
})().catch(async error=>{console.error(error);process.exitCode=1;await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'category-select-all-result.json'),JSON.stringify({passed:false,error:error.stack,errors,checks},null,2));if(page)try{await page.screenshot({path:path.join(evidence,'category-select-all-failure.png'),fullPage:true})}catch{}}).finally(async()=>{await browser?.close();if(child)try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{child.kill()}});
