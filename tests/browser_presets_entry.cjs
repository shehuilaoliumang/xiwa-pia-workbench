const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','presets-entry-'+Date.now()),base='http://127.0.0.1:8897';
let browser,child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8897','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1600,height:1120}}),errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.addInitScript(()=>{
    try{if(!localStorage.getItem('wb-preview-preferences'))localStorage.setItem('wb-preview-preferences',JSON.stringify({placement:'outside',feedback:'realtime'}))}catch{}
    window.addEventListener('message',event=>{if(event.origin===location.origin&&event.data?.type==='wb-preview')window.observedPresetSnapshot=event.data.snapshot});
  });
  const lib=async()=> (await context.request.get(base+'/api/library')).json();
  const state=async()=> (await context.request.get(base+'/api/state')).json();
  const presets=async()=> (await context.request.get(base+'/api/layout-presets')).json();
  const request=async(url,body,method='POST')=>{const current=await lib();return context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':current.csrf_token}})};
  const send=async(url,body,method='POST')=>{const response=await request(url,body,method);assert(response.ok(),await response.text());return response.json()};
  const initial=await lib(),script=initial.scripts.find(item=>item.id==='script-01');
  const page=await context.newPage();let frame;
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
  const useFrame=()=>{frame=page.frames().find(item=>item.url().includes('preview=1'));assert(frame)};
  const snapshot=()=>frame.evaluate(()=>window.observedPresetSnapshot);
  const viaHomepage=async()=>{await page.goto(base+'/');await page.locator('.main-nav [data-nav="control"]').click();await page.waitForURL(base+'/control');await ready();useFrame()};
  const visit=async url=>{await page.goto(base+url);await ready();useFrame()};
  const rootPayload={mode:'list',list_source:'categories',category_ids:[],directory_level:'categories',focus_category_id:null,orientation:'portrait'};

  // The normal control entry always prepares a fresh category overview, regardless of frozen live content.
  for(const [label,payload] of [
    ['legacy flat',{mode:'list',list_source:'categories',category_ids:[],orientation:'portrait'}],
    ['focused category',{...rootPayload,directory_level:'scripts',focus_category_id:script.category_id}],
    ['script body',{mode:'script',script_id:script.id,orientation:'portrait',layout:{body_mode:'scroll'}}]
  ]){
    await send('/api/apply',payload);await send('/api/command',{action:'play'});const before=await state();
    await viaHomepage();
    assert.equal(await page.locator('#preview-feedback-mode').inputValue(),'realtime');
    const draft=await snapshot();assert.equal(draft.mode,'list',label+' entry uses directory mode');assert.equal(draft.directory_level,'categories');assert.equal(draft.focus_category_id,null);
    assert(await frame.locator('[data-preview-category]').count()>0);assert.equal(await frame.locator('[data-preview-script]').count(),0);
    await delay(250);assert.equal((await state()).revision,before.revision,label+' entry must not publish');assert((await state()).playing,label+' entry must not pause live');
    await page.reload();await ready();useFrame();assert.equal((await snapshot()).directory_level,'categories');await delay(250);
    assert.equal((await state()).revision,before.revision,label+' reload with remembered realtime must not publish');
  }
  const directBefore=await state();await visit('/control?script='+script.id);await frame.locator('.stage-body').waitFor();
  assert.equal((await snapshot()).mode,'script');assert.equal((await snapshot()).scripts[0].id,script.id);
  assert.equal((await state()).revision,directBefore.revision,'explicit script entry prepares only a draft');
  await visit('/control');await page.locator('#preview-feedback-mode').selectOption('confirm');
  const baseline=await lib(),liveBaseline=await state(),defaults=baseline.default_layouts;
  for(const orientation of ['portrait','landscape'])assert.equal(defaults[orientation].media_caption_layout,'pages');
  const preset=page.locator('#layout-preset'),name=page.locator('#layout-preset-name');
  assert.equal(await preset.inputValue(),'default');
  const rangeIds={font_size:'font',line_height:'line',padding:'padding',background_opacity:'background',category_background_opacity:'category-background',speed:'speed'};
  const setLayout=async(orientation,changes)=>{
    await page.locator(`[data-orientation="${orientation}"]`).click();
    for(const [key,value] of Object.entries(changes)){
      if(key==='body_mode')await page.locator('#layout-body-mode').selectOption(value);
      else if(key==='category_columns')await page.locator('#layout-category-columns').selectOption(String(value));
      // Directory layout controls preserve these media-only defaults without exposing hidden fields.
      else if(key==='media_caption_mode'||key==='media_side'||key==='media_caption_layout')continue;
      else{assert(Object.hasOwn(rangeIds,key),'unmapped layout control: '+key);const input=page.locator('#layout-'+rangeIds[key]);await input.fill(String(value));await input.dispatchEvent('input')}
    }
    await until(async()=>{const draft=await snapshot();return draft?.orientation===orientation&&Object.entries(changes).every(([key,value])=>draft.layout[key]===value)},'draft layout '+orientation);await ready();
  };
  const portrait={...defaults.portrait,body_mode:'pages',font_size:42,line_height:1.9,padding:72,background_opacity:0.3,category_columns:1,category_background_opacity:0.65,speed:45};
  const landscape={...defaults.landscape,body_mode:'scroll',font_size:28,line_height:1.5,padding:80,background_opacity:0.2,category_columns:4,category_background_opacity:0.45,speed:22};
  await setLayout('portrait',portrait);await setLayout('landscape',landscape);
  await name.fill('验收方案一');await page.locator('#new-layout-preset').click();
  await until(async()=> (await presets()).layout_presets.length===1,'first preset saved');
  let saved=(await presets()).layout_presets[0];assert.deepEqual(saved.layouts,{portrait,landscape});
  assert.equal((await state()).revision,liveBaseline.revision);assert.deepEqual((await lib()).layouts,baseline.layouts,'saving a preset must not save active layout settings');
  await until(async()=>await preset.inputValue()===saved.id,'new preset selected');
  const duplicateResponse=page.waitForResponse(response=>response.url()===base+'/api/layout-presets'&&response.request().method()==='POST');
  await page.locator('#new-layout-preset').click();const duplicate=await duplicateResponse;
  assert.equal(duplicate.status(),409);const duplicateBody=await duplicate.json();assert.equal(duplicateBody.code,'duplicate_preset');
  await until(async()=> (await page.locator('#toast').textContent()).includes(duplicateBody.error),'duplicate preset error visible');
  assert.equal((await presets()).layout_presets.length,1);

  // Fill the documented upper bound through the API, then exercise the UI at that exact bound.
  for(let i=2;i<=10;i++)await send('/api/layout-presets',{name:'验收方案'+i,layouts:{portrait,landscape}});
  const overflow=await request('/api/layout-presets',{name:'第十一套',layouts:{portrait,landscape}});assert.equal(overflow.status(),409);assert.equal((await overflow.json()).code,'preset_limit');
  await page.reload();await ready();useFrame();assert.equal(await preset.locator('option').count(),11);assert(await page.locator('#new-layout-preset').isDisabled());
  assert.equal((await state()).revision,liveBaseline.revision);assert.deepEqual((await lib()).layouts,baseline.layouts);
  await preset.selectOption(saved.id);
  const revisedPortrait={...portrait,font_size:36,category_columns:2,category_background_opacity:0.3};
  const revisedLandscape={...landscape,body_mode:'pages',font_size:30,category_columns:3,category_background_opacity:0.9};
  await setLayout('portrait',revisedPortrait);await setLayout('landscape',revisedLandscape);await name.fill('验收方案一已更新');
  await page.locator('#update-layout-preset').click();await page.locator('#confirm-dialog').waitFor();
  await page.locator('#confirm-dialog button[value="cancel"]').click();
  assert.deepEqual((await presets()).layout_presets.find(item=>item.id===saved.id),saved,'canceling preset replacement keeps the old preset');
  await page.locator('#update-layout-preset').click();await page.locator('#confirm-yes').click();
  await until(async()=> (await presets()).layout_presets.find(item=>item.id===saved.id)?.name==='验收方案一已更新','preset renamed and updated');
  saved=(await presets()).layout_presets.find(item=>item.id===saved.id);assert.deepEqual(saved.layouts,{portrait:revisedPortrait,landscape:revisedLandscape});
  assert.equal((await state()).revision,liveBaseline.revision);assert.deepEqual((await lib()).layouts,baseline.layouts);

  // Loading a preset in confirmation mode changes both draft orientations, without applying either.
  await preset.selectOption('default');await page.locator('#load-layout-preset').click();await ready();
  await until(async()=>JSON.stringify((await snapshot()).layout)===JSON.stringify(defaults.landscape),'true landscape defaults loaded');
  await setLayout('portrait',{});assert.deepEqual((await snapshot()).layout,defaults.portrait);
  assert.equal((await presets()).layout_presets.length,10,'default loading retains all saved presets');
  await preset.selectOption(saved.id);await page.locator('#load-layout-preset').click();await ready();
  await until(async()=> (await snapshot()).layout.font_size===revisedPortrait.font_size,'custom portrait preset loaded');assert.deepEqual((await snapshot()).layout,revisedPortrait);
  await setLayout('landscape',{});assert.deepEqual((await snapshot()).layout,revisedLandscape);
  assert.equal((await state()).revision,liveBaseline.revision);assert.deepEqual((await lib()).layouts,baseline.layouts,'confirmation loading must not persist active layouts');
  await page.reload();await ready();useFrame();assert.equal((await presets()).layout_presets.find(item=>item.id===saved.id).name,'验收方案一已更新');
  assert.equal(await preset.locator('option').count(),11);assert.equal((await state()).revision,liveBaseline.revision);

  // Explicit realtime activation applies the current draft; selecting a preset alone still does not apply it.
  await page.locator('#preview-feedback-mode').selectOption('realtime');await until(async()=> (await state()).revision>liveBaseline.revision,'realtime explicitly enabled');await ready();
  const beforeSelection=await state();await preset.selectOption(saved.id);await delay(200);assert.equal((await state()).revision,beforeSelection.revision,'selecting a preset does not load it');
  await page.locator('#load-layout-preset').click();
  await until(async()=>{const live=await state();return live.revision>beforeSelection.revision&&live.snapshot.layout.font_size===revisedPortrait.font_size},'realtime preset load applies');
  assert.deepEqual((await state()).snapshot.layout,revisedPortrait);assert.deepEqual((await lib()).layouts.portrait,revisedPortrait);
  await setLayout('landscape',{});await until(async()=> (await state()).orientation==='landscape','loaded second orientation applies in realtime');
  assert.deepEqual((await state()).snapshot.layout,revisedLandscape);
  const beforeDelete=await lib(),deleteRevision=(await state()).revision;
  await page.locator('#delete-layout-preset').click();await page.locator('#confirm-dialog').waitFor();await page.locator('#confirm-dialog button[value="cancel"]').click();
  assert.equal((await presets()).layout_presets.length,10);
  await page.locator('#delete-layout-preset').click();await page.locator('#confirm-yes').click();
  await until(async()=> (await presets()).layout_presets.length===9,'preset deleted');
  assert.equal((await state()).revision,deleteRevision);assert.deepEqual((await lib()).layouts,beforeDelete.layouts,'deletion must not load default settings');
  assert.equal(await preset.inputValue(),'default');assert(!(await page.locator('#new-layout-preset').isDisabled()));
  await page.locator('#load-layout-preset').click();await until(async()=> (await state()).snapshot.layout.body_mode==='pages'&&(await state()).snapshot.layout.category_columns===0,'realtime default load');
  assert.deepEqual((await state()).snapshot.layout,defaults.landscape);assert.equal((await presets()).layout_presets.length,9);
  await page.locator('#preview-feedback-mode').selectOption('confirm');

  await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});
  await page.locator('#layout-settings-panel').screenshot({path:path.join(root,'.qa','browser','presets-controls-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page has no horizontal overflow');
  for(const element of await page.locator('.layout-presets button,.layout-presets input,.layout-presets select').all()){
    const box=await element.boundingBox();assert(box.x>=0&&box.x+box.width<=391,'preset controls fit the mobile viewport');
  }
  await page.locator('#layout-settings-panel').screenshot({path:path.join(root,'.qa','browser','presets-controls-mobile.png')});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'.qa','browser','presets-entry-result.json'),JSON.stringify({passed:true,browserErrors:errors,checks:[
    'homepage control entry always starts at category overview','legacy, focused and body live snapshots remain untouched',
    'remembered realtime and reload never publish initial drafts','explicit script deep link retains body entry',
    'ten preset limit and duplicate-name feedback','save, replace and delete require no live or active-layout changes',
    'preset update cancellation and confirmed rename with both orientations','confirmation loads only the draft',
    'system defaults restore actual defaults and retain saved presets','realtime preset load applies both orientation settings as selected',
    'preset persistence after refresh','media caption layout retained in both orientations','desktop and mobile control bounds'
  ]},null,2));
  console.log('Preset and entry acceptance passed: safe initial directory, ten presets, independent layouts, save/load boundaries, defaults and responsive controls.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill()});
