const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');

const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','category-layout-'+Date.now()),base='http://127.0.0.1:8895';
let browser,child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});

(async()=>{
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8895','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1600,height:1120}}),errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.addInitScript(()=>{
    window.categoryDiagnostics={messages:[],motion:null,motionCount:0};
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin)return;
      if(event.data?.type==='wb-preview')window.observedPreviewSnapshot=event.data.snapshot;
      if(['wb-preview-live-binding','wb-preview-position','wb-preview-rendered'].includes(event.data?.type)){
        window.categoryDiagnostics.messages.push(event.data);window.categoryDiagnostics.messages=window.categoryDiagnostics.messages.slice(-12);
      }
    });
    const monitor=new BroadcastChannel('wb-live-display-v1');
    monitor.onmessage=event=>{if(event.data?.type==='motion'){window.categoryDiagnostics.motion=event.data;window.categoryDiagnostics.motionCount++}};
  });
  const lib=async()=> (await context.request.get(base+'/api/library')).json();
  const state=async()=> (await context.request.get(base+'/api/state')).json();
  const send=async(url,body,method='POST')=>{
    const current=await lib(),response=await context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':current.csrf_token}});
    assert(response.ok(),await response.text());return response.json();
  };
  const initial=await lib(),script=initial.scripts.find(item=>item.id==='script-01');
  const featured=await send('/api/categories',{name:'布局验收分组',description:'四篇资料用于验证最多三篇摘要',color:'#8b6645',visible:true});
  const empty=await send('/api/categories',{name:'布局验收空分组',description:'暂无条目',color:'#55746c',visible:true});
  for(let i=1;i<=4;i++)await send('/api/scripts',{
    title:'布局验收条目 '+i,category_id:featured.id,author:'验收作者',synopsis:'这是一段较长的测试简介，用于检查分组摘要的文字排列及边界。',
    cast_note:'两人配音',tags:['测试'],notes:'',visible:true,blocks:[{id:'layout-test-block-'+i,kind:'text',text:'验收对白 '+i}]
  });
  await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});
  const page=await context.newPage();let frame;
  const capture=name=>page.locator('.preview-panel').screenshot({path:path.join(root,'.qa','browser','category-layout-'+name+'.png')});
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
  const visit=async()=>{await page.goto(base+'/control');await ready();frame=page.frames().find(item=>item.url().includes('preview=1'));assert(frame)};
  const snapshot=()=>frame.evaluate(()=>window.observedPreviewSnapshot);
  const rootPayload={mode:'list',list_source:'categories',category_ids:[],directory_level:'categories',focus_category_id:null,orientation:'portrait'};

  // Old clients produced flat, un-focused lists. Only the new controller draft migrates.
  await send('/api/apply',{mode:'list',list_source:'categories',category_ids:[],orientation:'portrait'});
  const legacy=await state();assert.equal(legacy.snapshot.directory_level,'scripts');assert.equal(legacy.snapshot.focus_category_id,null);
  await visit();
  await frame.locator(`[data-preview-category="${featured.id}"]`).waitFor();
  assert.equal((await snapshot()).directory_level,'categories');assert.equal((await state()).revision,legacy.revision,'initial legacy migration must not publish');

  // Every ordinary entry starts with the category overview, even after a modern
  // focused directory/body was published; explicit script links still open that body.
  await send('/api/apply',{...rootPayload,directory_level:'scripts',focus_category_id:script.category_id});
  const focused=await state();await visit();await frame.locator('[data-preview-category]').first().waitFor();
  assert.equal((await snapshot()).directory_level,'categories');assert.equal((await state()).revision,focused.revision);
  await send('/api/apply',{mode:'script',script_id:script.id,orientation:'portrait'});
  const body=await state();await visit();await frame.locator('[data-preview-category]').first().waitFor();
  assert.equal((await snapshot()).mode,'list');assert.equal((await state()).revision,body.revision);
  await page.goto(base+'/control?script='+script.id);await ready();frame=page.frames().find(item=>item.url().includes('preview=1'));
  await frame.locator('.stage-body').waitFor();assert.equal((await snapshot()).mode,'script');assert.equal((await state()).revision,body.revision);

  await send('/api/apply',rootPayload);await visit();
  const columns=page.locator('#layout-category-columns'),opacity=page.locator('#layout-category-background');
  const feedback=page.locator('#preview-feedback-mode');
  await feedback.selectOption('confirm');const confirmBaseline=await state();
  const changeColumns=async value=>{
    await columns.selectOption(String(value));
    await until(async()=>Number((await snapshot())?.layout.category_columns)===value,'preview category columns '+value);await ready();
  };
  const changeOpacity=async value=>{
    await opacity.fill(String(value));await opacity.dispatchEvent('input');
    await until(async()=>Math.abs(Number((await snapshot())?.layout.category_background_opacity)-value)<0.001,'preview category background '+value);await ready();
  };
  for(const value of [0,1,2,3,4]){
    await changeColumns(value);
    const rendered=await frame.locator('.stage-category-list').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(/\s+/).length);
    if(value>0)assert.equal(rendered,value,'explicit category column count should be rendered');else assert(rendered>=1&&rendered<=4,'automatic columns remain bounded');
    if(value===2||value===4)await capture('portrait-'+value+'-columns');
  }
  for(const value of [0,1,0.35]){
    await changeOpacity(value);
    const actual=await frame.locator(`[data-preview-category="${featured.id}"]`).evaluate(element=>Number(getComputedStyle(element,'::before').opacity));
    assert(Math.abs(actual-value)<0.01,'background opacity controls the card image independently');
  }
  assert.equal((await state()).revision,confirmBaseline.revision,'confirmation layout changes must remain drafts');
  const apply=async()=>{const previous=(await state()).revision;await page.locator('#apply-display').click();await until(async()=> (await state()).revision>previous,'explicit layout application');await ready()};
  await changeColumns(2);await changeOpacity(0.25);await apply();
  await page.locator('[data-orientation="landscape"]').click();await ready();
  await changeColumns(4);await changeOpacity(0.8);await apply();await capture('landscape-4-columns');
  let current=await lib();
  assert.equal(current.layouts.portrait.category_columns,2);assert.equal(current.layouts.portrait.category_background_opacity,0.25);
  assert.equal(current.layouts.landscape.category_columns,4);assert.equal(current.layouts.landscape.category_background_opacity,0.8);
  const savedRevision=(await state()).revision;
  await page.locator('[data-orientation="portrait"]').click();await ready();
  assert.equal(await columns.inputValue(),'2');assert.equal(Number(await opacity.inputValue()),0.25);
  assert.equal((await state()).revision,savedRevision,'changing orientation in confirmation mode must not publish');
  await visit();assert.equal(await columns.inputValue(),'4');assert.equal(Number(await opacity.inputValue()),0.8);
  assert.equal((await state()).revision,savedRevision,'re-entering control must not publish');

  // Saved layout settings take precedence over an older frozen live snapshot on re-entry.
  await send('/api/layouts',{orientation:'landscape',layout:{...current.layouts.landscape,category_columns:3,category_background_opacity:0.45}},'PATCH');
  await visit();assert.equal(await columns.inputValue(),'3');assert.equal(Number(await opacity.inputValue()),0.45);
  assert.equal((await state()).revision,savedRevision);
  await feedback.selectOption('realtime');
  await until(async()=> (await state()).snapshot.layout.category_columns===3,'explicit realtime enables current saved layout');
  await changeColumns(1);await changeOpacity(0.55);
  await until(async()=>{const live=await state();return live.snapshot.layout.category_columns===1&&Math.abs(live.snapshot.layout.category_background_opacity-0.55)<0.001},'realtime category layout update');

  const audience=await context.newPage();await audience.setViewportSize({width:620,height:1000});await audience.goto(base+'/display');
  await audience.locator('[data-anchor="category:'+featured.id+'"]').waitFor();
  await page.bringToFront();await ready();await page.locator('.preview-panel').scrollIntoViewIfNeeded();
  const card=frame.locator(`[data-preview-category="${featured.id}"]`),peek=frame.locator('#stage-category-peek');
  await card.hover();
  await until(async()=>await peek.getAttribute('data-category-peek')==='category:'+featured.id,'single-column hover preview');
  assert.equal(await peek.locator('.category-peek-script').count(),3,'hover preview shows at most three scripts');
  try{
    await until(async()=>await audience.evaluate(()=>document.querySelector('#stage-category-peek')?.getAttribute('data-category-peek'))==='category:'+featured.id,'realtime hover reaches audience');
  }catch(error){
    const live=await state();
    const diagnostic={label:'category hover diagnostics',live:{revision:live.revision,snapshot_id:live.snapshot?.id,layout:live.snapshot?.layout},
      preview:await frame.evaluate(()=>({diagnostics:window.categoryDiagnostics,visibility:document.visibilityState,peek:document.querySelector('#stage-category-peek')?.dataset.categoryPeek,scroll_top:document.querySelector('#stage-scroll')?.scrollTop})),
      audience:await audience.evaluate(()=>({diagnostics:window.categoryDiagnostics,visibility:document.visibilityState,peek:document.querySelector('#stage-category-peek')?.dataset.categoryPeek,scroll_top:document.querySelector('#stage-scroll')?.scrollTop})),errors};
    await fs.writeFile(path.join(root,'.qa','browser','category-hover-diagnostic.json'),JSON.stringify(diagnostic,null,2));
    console.error(JSON.stringify(diagnostic,null,2));throw error;
  }
  const bounds=await peek.evaluate(element=>{
    const box=element.getBoundingClientRect(),viewport=document.querySelector('#stage-scroll').getBoundingClientRect();
    return {inside:box.left>=viewport.left-1&&box.top>=viewport.top-1&&box.right<=viewport.right+1&&box.bottom<=viewport.bottom+1};
  });assert(bounds.inside,'hover details stay inside the visible stage');
  await until(async()=>await frame.locator('.preview-toolbar').evaluate(e=>Number(getComputedStyle(e).opacity))<0.01,'summary is not covered by the floating toolbar');
  await peek.focus();await capture('landscape-single-hover');
  await frame.locator(`[data-preview-category="${empty.id}"]`).focus();
  await until(async()=>await peek.getAttribute('data-category-peek')==='category:'+empty.id,'keyboard focus selects category details');
  assert(await peek.locator('.category-peek-empty').isVisible());assert.equal(await peek.locator('.category-peek-script').count(),0);

  await page.locator('[data-orientation="portrait"]').click();await ready();await changeColumns(1);
  await until(async()=>{const live=await state();return live.orientation==='portrait'&&live.snapshot.layout.category_columns===1},'portrait single-column sync');
  await card.hover();await until(async()=>await peek.getAttribute('data-category-peek')==='category:'+featured.id,'portrait hover');
  await peek.focus();await capture('portrait-single-hover');

  await feedback.selectOption('confirm');
  await until(async()=>!(await audience.locator('#stage-category-peek').isVisible()),'unbound audience hover expires');
  const frozenRevision=(await state()).revision;
  await card.hover();await until(async()=>await peek.getAttribute('data-category-peek')==='category:'+featured.id,'confirm hover remains available locally');
  await delay(400);
  assert(!(await audience.locator('#stage-category-peek').isVisible()),'confirmation mode must not transmit category hover');
  assert.equal((await state()).revision,frozenRevision);
  await page.setViewportSize({width:390,height:844});await page.locator('#preview-frame').scrollIntoViewIfNeeded();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile controller has no horizontal overflow');
  await frame.locator(`[data-preview-category="${empty.id}"]`).focus();
  await until(async()=>await peek.isVisible()&&await peek.getAttribute('data-category-peek')==='category:'+empty.id,'mobile focused category summary remains visible');
  const mobileBounds=await peek.evaluate(element=>{const r=element.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1});
  assert(mobileBounds,'category details stay inside the mobile preview');
  await peek.focus();await until(async()=>await frame.locator('.preview-toolbar').evaluate(e=>Number(getComputedStyle(e).opacity))<0.01,'mobile summary is unobstructed');
  await capture('mobile-single-hover');assert(await peek.isVisible(),'mobile summary stays visible during keyboard inspection');
  assert.deepEqual(errors,[]);
  await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});
  await fs.writeFile(path.join(root,'.qa','browser','category-layout-result.json'),JSON.stringify({passed:true,browserErrors:errors,checks:[
    'legacy flat snapshot migrates only the controller draft','fresh category entry regardless of saved live navigation, explicit script link remains supported',
    'automatic and explicit category columns','category background image opacity','confirmation layout isolation',
    'independent portrait and landscape settings','saved settings survive re-entry without overwriting live',
    'realtime layout and category hover propagation','three-script hover limit, keyboard focus and empty category',
    'confirmation hover isolation','desktop and mobile preview bounds'
  ]},null,2));
  console.log('Category layout acceptance passed: initial directory compatibility, saved independent layouts, hover details, realtime isolation and mobile bounds.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill();
});
