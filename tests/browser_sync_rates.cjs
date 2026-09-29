'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime/python.exe');
const data=path.join(root,'.qa','sync-rates-'+Date.now()),base='http://127.0.0.1:8931';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server,browser;const result={passed:false,checks:[],rates:[],errors:[]};
async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await delay(80)}throw Error('Timed out: '+label)}
function wav(seconds=30){const rate=8000,n=seconds*rate,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b}
(async()=>{
 server=spawn(python,['-X','utf8','run.py','--no-browser','--port','8931','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
 await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--autoplay-policy=no-user-gesture-required']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 context.on('page',p=>p.on('pageerror',e=>result.errors.push(e.message)));
 const library=async()=>(await context.request.get(base+'/api/library')).json(),state=async()=>(await context.request.get(base+'/api/state')).json();
 const send=async(url,body)=>{const lib=await library(),r=await context.request.post(base+url,{data:body,headers:{'X-CSRF-Token':lib.csrf_token}});assert(r.ok(),await r.text());return r.json()};
 const lib=await library();
 const script=await send('/api/scripts',{title:'频率验收剧本',category_id:lib.categories[0].id,blocks:Array.from({length:70},(_,i)=>({kind:'text',role:i%2?'乙':'甲',text:'用于确认连续滚动、频率计数与媒体独立时钟。'.repeat(12)}))});
 const page=await context.newPage();await page.goto(base+'/control?script='+script.id);
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);await ready();
 assert.equal(await page.locator('#preview-sync-rate').inputValue(),'60');
 assert((await page.locator('#preview-sync-metrics').innerText()).includes('逐步应用'));
 await page.locator('#preview-toolbar-placement').selectOption('outside');
 await page.locator('#layout-body-mode').selectOption('scroll');await ready();
 const popup=context.waitForEvent('page');await page.locator('#open-display').click();const display=await popup;await display.waitForLoadState();await page.bringToFront();
 await page.locator('#preview-feedback-mode').selectOption('realtime');
 await until(async()=>(await state()).snapshot?.scripts[0]?.id===script.id,'realtime apply');await delay(1200);
 await until(async()=>(await page.locator('#preview-sync-metrics').getAttribute('data-state'))==='idle','stationary status');
 await page.evaluate(()=>{window.__motions=[];window.__channel=new BroadcastChannel('pia-live-display-v1');window.__channel.onmessage=e=>{if(e.data?.type==='motion')window.__motions.push({at:performance.now(),data:e.data})};});
 const frame=page.frames().find(f=>f.url().includes('preview=1'));
 await page.locator('[data-preview-external="play"]').click();await until(async()=>(await state()).playing,'scroll starts');await delay(700);
 const mutations=[];page.on('request',r=>{if(['POST','PATCH','PUT','DELETE'].includes(r.method()))mutations.push(r.url())});
 const before=await state();
 for(const target of [30,60,90,120]){
  await page.locator('#preview-sync-rate').selectOption(String(target));await delay(1200);
  await page.evaluate(()=>{window.__motions=[];window.__sampleAt=performance.now()});await delay(2000);
  const sample=await page.evaluate(()=>({count:window.__motions.length,elapsed:performance.now()-window.__sampleAt,positions:window.__motions.map(m=>m.data.scroll_top)}));
  const hz=sample.count*1000/sample.elapsed;assert(hz>=20&&hz<=target+8,`target ${target}: ${hz}`);
  if(target===30)assert(hz>=26&&hz<=34,'30 target close to achieved rate');
  const text=await page.locator('#preview-sync-metrics').innerText();assert(text.includes(`目标 ${target}`)&&text.includes('发送')&&text.includes('接收'),text);
  const [a,b]=await Promise.all([frame.locator('#stage-scroll').evaluate(e=>e.scrollTop),display.locator('#stage-scroll').evaluate(e=>e.scrollTop)]);assert(Math.abs(a-b)<30,'audience follows current scroll');
  result.rates.push({target,measured_hz:hz,ui:text,position_error:Math.abs(a-b)});
 }
 assert.equal((await state()).revision,before.revision,'rate selection must not alter server state');
 assert.deepEqual(mutations,[],'rate selection makes no write requests');result.checks.push('four rates with observed send/receive; unchanged live revision; no write requests; continuous scroll tracking');
 await page.locator('#preview-feedback-mode').selectOption('confirm');await delay(500);await page.evaluate(()=>window.__motions=[]);await delay(600);assert.equal(await page.evaluate(()=>window.__motions.length),0);assert((await page.locator('#preview-sync-metrics').innerText()).includes('逐步应用'));
 await page.reload();await ready();assert.equal(await page.locator('#preview-sync-rate').inputValue(),'120');result.checks.push('confirmation disconnects; local preference survives reload');
 // The same 120 Hz preference must leave media clock corrections near 10 Hz.
 const csrf=(await library()).csrf_token;const uploaded=await context.request.post(base+'/api/scripts/'+script.id+'/media',{multipart:{file:{name:'sync-clock.wav',mimeType:'audio/wav',buffer:wav()}},headers:{'X-CSRF-Token':csrf}});assert(uploaded.ok(),await uploaded.text());
 await page.goto(base+'/control?script='+script.id+'&body=media');await ready();
 const mediaFrame=page.frames().find(f=>f.url().includes('preview=1'));await mediaFrame.locator('.pia-media-player').waitFor();
 await page.locator('#preview-feedback-mode').selectOption('realtime');await until(async()=>(await state()).snapshot?.layout?.body_mode==='media','media applied');await delay(500);
 await page.evaluate(()=>{window.__motions=[];window.__channel=new BroadcastChannel('pia-live-display-v1');window.__channel.onmessage=e=>{if(e.data?.type==='motion')window.__motions.push({at:performance.now()})}});
 await page.locator('[data-preview-external="play"]').click();await until(async()=>(await state()).playing,'media plays');await delay(1000);
 await page.evaluate(()=>{window.__motions=[];window.__sampleAt=performance.now()});await delay(2200);
 const media=await page.evaluate(()=>({count:window.__motions.length,elapsed:performance.now()-window.__sampleAt}));media.hz=media.count*1000/media.elapsed;assert(media.hz>=8&&media.hz<=12,JSON.stringify(media));
 assert((await page.locator('#preview-sync-metrics').innerText()).includes('目标 10'));result.media=media;result.checks.push('120 preference retains independent media correction at 10 Hz');
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await fs.mkdir(path.join(root,'.qa/browser'),{recursive:true});await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa/browser/sync-rates-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa/browser/sync-rates-desktop.png')});
 assert.deepEqual(result.errors,[]);result.passed=true;console.log('Sync rate browser acceptance passed:',JSON.stringify(result.rates));
})().catch(error=>{result.error=error.stack;console.error(error);process.exitCode=1}).finally(async()=>{await fs.mkdir(path.join(root,'.qa/browser'),{recursive:true});await fs.writeFile(path.join(root,'.qa/browser/sync-rates-result.json'),JSON.stringify(result,null,2));await browser?.close();if(server)try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{server.kill()}});
