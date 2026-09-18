const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','control-columns-'+Date.now()),base='http://127.0.0.1:8903';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
let browser,child;
(async()=>{
 child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8903','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
 await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[],sizes=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/control');await page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
 const state=async()=>(await context.request.get(base+'/api/state')).json(),initial=await state();
 const check=async(width,height,open=false)=>{
  await page.setViewportSize({width,height});
  await page.locator('.live-details').evaluate((e,value)=>e.open=value,open);
  await delay(200);
  const box=await page.evaluate(()=>{const r=s=>{const x=document.querySelector(s).getBoundingClientRect();return {x:x.x,y:x.y,width:x.width,height:x.height,bottom:x.bottom}};return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,prepare:r('.prepare-panel'),settings:r('#layout-settings-panel'),left:r('.control-settings'),preview:r('.preview-panel'),scroll:getComputedStyle(document.querySelector('#layout-settings-scroll')).overflowY,liveInside:document.querySelector('.preview-panel').contains(document.querySelector('#live-pause'))}});
  assert(!box.overflow,`no horizontal overflow at ${width}`);assert(box.liveInside,'live controls consolidated inside preview');
  if(width>1040){assert(box.left.height<=box.preview.height+1,JSON.stringify(box));assert(box.settings.bottom<=box.preview.bottom+1);assert.equal(box.scroll,'auto');assert(box.settings.height>280);}
  else{assert(box.prepare.bottom<=box.preview.y+1);assert(box.preview.bottom<=box.settings.y+1);assert.equal(box.scroll,'visible');}
  for(const target of ['#save-layout','#apply-display','#live-pause']){await page.locator(target).scrollIntoViewIfNeeded();const b=await page.locator(target).boundingBox();assert(b.width>40&&b.x>=0&&b.x+b.width<=width+1,target+' stays reachable');}
  sizes.push({viewport:`${width}x${height}`,open,...box});
 };
 for(const [w,h] of [[1440,900],[1440,600],[1200,800],[1041,800],[1040,800],[768,1024],[390,844],[320,740]])await check(w,h);
 await page.setViewportSize({width:1440,height:900});await page.locator('#preview-toolbar-placement').selectOption('outside');await check(1440,900,true);
 const scroll=page.locator('#layout-settings-scroll');await scroll.focus();await page.keyboard.press('End');await until(async()=>await scroll.evaluate(e=>e.scrollTop>=e.scrollHeight-e.clientHeight-1),'keyboard reaches settings end');
 assert.equal((await state()).revision,initial.revision,'layout inspection does not publish');assert.deepEqual(errors,[]);
 await fs.mkdir(path.join(root,'.qa/browser'),{recursive:true});await page.locator('.live-details').evaluate(e=>e.open=false);await page.locator('.control-layout').screenshot({path:path.join(root,'.qa/browser/control-columns-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'.qa/browser/control-columns-mobile.png'),fullPage:true});
 await fs.writeFile(path.join(root,'.qa/browser/control-columns-result.json'),JSON.stringify({passed:true,errors,sizes},null,2));console.log('Control columns: desktop height, responsive order, consolidated controls, keyboard and draft isolation passed.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();if(child)try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{child.kill()}});
