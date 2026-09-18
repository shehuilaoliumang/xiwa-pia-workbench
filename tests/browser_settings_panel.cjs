const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','settings-panel-'+Date.now()),base='http://127.0.0.1:8899';
let browser,child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8899','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900}}),errors=[],sizes=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const lib=async()=> (await context.request.get(base+'/api/library')).json();
  const state=async()=> (await context.request.get(base+'/api/state')).json();
  const page=await context.newPage();await page.goto(base+'/control');
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
  await ready();const initial=await state();
  const panel=page.locator('#layout-settings-panel'),scroll=page.locator('#layout-settings-scroll');
  const noOverflow=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page has no horizontal overflow');
  const geometry=()=>panel.evaluate(element=>{
    const region=element.querySelector('#layout-settings-scroll'),head=element.querySelector('.layout-settings-header'),foot=element.querySelector('.layout-settings-footer');
    const rect=element.getBoundingClientRect(),h=head.getBoundingClientRect(),f=foot.getBoundingClientRect();
    return {height:rect.height,top:rect.top,bottom:rect.bottom,headTop:h.top-rect.top,footBottom:f.bottom-rect.top,
      scrollTop:region.scrollTop,scrollHeight:region.scrollHeight,clientHeight:region.clientHeight,overflow:getComputedStyle(region).overflowY,
      columns:getComputedStyle(element.querySelector('.layout-fields')).gridTemplateColumns.split(/\s+/).length};
  });
  const footerVisible=async()=>{
    const boxes=await panel.evaluate(element=>{const panel=element.getBoundingClientRect(),button=element.querySelector('#save-layout').getBoundingClientRect();return {inside:button.top>=panel.top&&button.bottom<=panel.bottom,viewport:button.top>=0&&button.bottom<=innerHeight}});
    assert(boxes.inside&&boxes.viewport,'save entry stays visible within the card and current viewport');
  };
  await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});
  await panel.scrollIntoViewIfNeeded();let before=await geometry();
  assert(before.height>=280&&before.height<=852,'desktop settings card is bounded');
  assert.equal(before.columns,2);assert.equal(before.overflow,'auto');assert(before.scrollHeight>before.clientHeight+100,'inner controls genuinely scroll');
  assert.equal(await scroll.getAttribute('tabindex'),'0');assert(await page.locator('#layout-scroll-help').isVisible());
  await footerVisible();await noOverflow();sizes.push({viewport:'1440x900',...before});
  await panel.screenshot({path:path.join(root,'.qa','browser','settings-panel-desktop-top.png')});

  // Keyboard scrolling and native focus reveal controls without moving header/footer inside the card.
  await scroll.focus();await page.keyboard.press('End');
  await until(async()=>await scroll.evaluate(element=>element.scrollTop>=element.scrollHeight-element.clientHeight-1),'keyboard scroll reaches the end');
  await scroll.evaluate(element=>{element.scrollTop=element.scrollHeight});const after=await geometry();
  assert(Math.abs(after.headTop-before.headTop)<1);assert(Math.abs(after.footBottom-before.footBottom)<1);
  for(const control of await scroll.locator('input,select,button').all()){
    if(await control.isDisabled()||!await control.isVisible())continue;
    await control.focus();
    try{await until(async()=>await control.evaluate(element=>{const r=element.getBoundingClientRect(),s=document.querySelector('#layout-settings-scroll').getBoundingClientRect();return r.top>=s.top-1&&r.bottom<=s.bottom+1}),'focused control scrolls into view: '+await control.getAttribute('id'))}catch(error){console.error(await control.evaluate(element=>{const r=element.getBoundingClientRect(),s=document.querySelector('#layout-settings-scroll').getBoundingClientRect();return {id:element.id,item:{top:r.top,bottom:r.bottom},region:{top:s.top,bottom:s.bottom},active:document.activeElement.id}}));throw error}
    const focusBounds=await control.evaluate(element=>{const item=element.getBoundingClientRect(),scroll=document.querySelector('#layout-settings-scroll'),region=scroll.getBoundingClientRect();return {id:element.id,item:{top:item.top,bottom:item.bottom},region:{top:region.top,bottom:region.bottom},scrollTop:scroll.scrollTop,inside:item.top>=region.top-1&&item.bottom<=region.bottom+1}});
    assert(focusBounds.inside,'every enabled layout control is reachable through focus: '+JSON.stringify(focusBounds));
  }
  await page.locator('#layout-preset-name').fill('卡片滚动验收方案');await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'new-layout-preset','keyboard reaches the preset action after the name field');
  await page.keyboard.press('Enter');await until(async()=> (await lib()).layout_presets.some(item=>item.name==='卡片滚动验收方案'),'preset control works at the end of the scroll region');
  await scroll.evaluate(element=>{element.scrollTop=element.scrollHeight});await panel.scrollIntoViewIfNeeded();await footerVisible();
  await panel.screenshot({path:path.join(root,'.qa','browser','settings-panel-desktop-bottom.png')});
  await page.locator('#layout-font').fill('44');await page.locator('#layout-font').dispatchEvent('input');await ready();
  await page.locator('#save-layout').click();await until(async()=> (await lib()).layouts.portrait.font_size===44,'fixed save entry remains functional');
  assert.equal((await state()).revision,initial.revision,'settings changes and saving do not publish a confirmation draft');

  const externalFits=async()=>{
    await page.locator('#preview-toolbar-placement').selectOption('outside');
    const actions=page.locator('.preview-actions');await actions.scrollIntoViewIfNeeded();
    const bounds=await actions.boundingBox();
    for(const button of await page.locator('#preview-external-tools button:visible,#apply-display').all()){
      const box=await button.boundingBox();
      assert(box.x>=bounds.x-1&&box.x+box.width<=bounds.x+bounds.width+1,'external controls fit the preview action width');
      assert(box.y>=bounds.y-1&&box.y+box.height<=bounds.y+bounds.height+1,'external controls are not vertically clipped');
    }
    const preview=await page.locator('.preview-panel').boundingBox(),frame=await page.locator('#preview-frame').boundingBox();
    assert(frame.x>=preview.x&&frame.x+frame.width<=preview.x+preview.width&&frame.y+frame.height<=preview.y+preview.height,'preview frame remains inside its panel');
    await noOverflow();
  };
  await externalFits();

  await page.setViewportSize({width:1440,height:600});await panel.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));
  await until(async()=>{const box=await panel.boundingBox();return box.y>=0&&box.y+box.height<=600},'short-screen card centered in view');before=await geometry();
  assert(before.height>=380&&before.height<=552,'short-screen card fits the viewport height');assert(before.clientHeight>=150,'short-screen scroll area remains usable');
  assert(before.top>=0&&before.bottom<=600,'short-screen panel bounds: '+JSON.stringify(before));assert.equal(before.columns,2);await footerVisible();await noOverflow();sizes.push({viewport:'1440x600',...before});
  await scroll.focus();await page.keyboard.press('Home');await until(async()=>await scroll.evaluate(element=>element.scrollTop)<2,'keyboard returns to the first controls');
  await panel.screenshot({path:path.join(root,'.qa','browser','settings-panel-short-screen.png')});await externalFits();

  await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();before=await geometry();
  assert.equal(before.overflow,'visible','mobile settings expand instead of using a cramped nested scroller');
  assert(before.scrollHeight<=before.clientHeight+1,'mobile controls are in the normal document flow');assert.equal(before.columns,2);
  assert(!(await page.locator('#layout-scroll-help').isVisible()));await noOverflow();sizes.push({viewport:'390x844',...before});
  await page.locator('#layout-preset-name').focus();assert.equal(await page.evaluate(()=>document.activeElement.id),'layout-preset-name');
  await page.locator('#save-layout').scrollIntoViewIfNeeded();
  const saveBox=await page.locator('#save-layout').boundingBox();assert(saveBox.y>=0&&saveBox.y+saveBox.height<=844);assert(saveBox.height>=44);
  await page.locator('#toast').waitFor({state:'hidden'});
  await panel.screenshot({path:path.join(root,'.qa','browser','settings-panel-mobile.png')});await externalFits();
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'.qa','browser','settings-panel-result.json'),JSON.stringify({passed:true,browserErrors:errors,sizes,checks:[
    'bounded desktop and short-screen card heights','fixed heading/orientation and save entry','discoverable keyboard-accessible scroll area',
    'all enabled controls can receive visible focus','preset creation at the scroll end','save entry remains functional without publishing',
    'two-column controls retained','mobile expands in normal document flow','external preview actions stay inside their panel','no horizontal page overflow'
  ]},null,2));
  console.log('Settings panel acceptance passed: bounded desktop card, accessible internal scrolling, fixed save entry, natural mobile flow and preview bounds.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill()});
