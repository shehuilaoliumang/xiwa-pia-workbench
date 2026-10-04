const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {spawn,execFileSync} = require('node:child_process');
const path = require('node:path'), fs = require('node:fs/promises');
const root = path.resolve(__dirname,'..'), python = path.join(root,'runtime','python.exe');
const data = path.join(root,'.qa','preview-size-'+Date.now()), base = 'http://127.0.0.1:8906';
const evidence = path.join(root,'.qa','browser'), measureOnly = process.argv.includes('--measure-only');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
function wav(seconds=12){const rate=8000,n=seconds*rate,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b}
let browser,child,page;
const errors=[],sizes=[],checks=[];
(async()=>{
  await fs.mkdir(evidence,{recursive:true});
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8906','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated 8906 server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
  const library=async()=>(await context.request.get(base+'/api/library')).json(), state=async()=>(await context.request.get(base+'/api/state')).json();
  const send=async(url,body,method='POST')=>{const lib=await library(),response=await context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':lib.csrf_token}});assert(response.ok(),await response.text());return response.json()};
  page=await context.newPage();
  const calls=[];page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(?:preview|apply|command)$/.test(new URL(request.url()).pathname))calls.push(new URL(request.url()).pathname)});
  await page.goto(base+'/control');
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
  await ready();let frame=page.frames().find(item=>item.url().includes('preview=1'));assert(frame);
  const measure=async(label)=>{
    const result=await page.evaluate(()=>{
      const box=selector=>{const node=document.querySelector(selector),rect=node.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom,right:rect.right}};
      return {viewport:{width:innerWidth,height:innerHeight},orientation:document.querySelector('.preview-panel').dataset.previewOrientation,focus:document.body.classList.contains('preview-focus'),overflow:document.documentElement.scrollWidth>innerWidth,frame:box('#preview-frame'),surround:box('.preview-surround'),panel:box('.preview-panel'),left:box('.control-settings'),settings:box('#layout-settings-panel')};
    });
    result.stage=await frame.locator('.display-stage').evaluate(element=>{const rect=element.getBoundingClientRect();return {width:rect.width,height:rect.height,orientation:element.classList.contains('landscape')?'landscape':'portrait',font:getComputedStyle(element).getPropertyValue('--stage-font').trim()}});
    result.label=label;sizes.push(result);return result;
  };
  const initial=await state(),baseline=await measure('1440 default portrait');
  if(measureOnly){await fs.writeFile(path.join(evidence,'preview-size-baseline.json'),JSON.stringify({sizes,errors},null,2));console.log(JSON.stringify(baseline));return}
  assert.equal(baseline.orientation,'portrait');
  assert(Math.abs(baseline.stage.width-460)<=5,'desktop portrait canvas should be 460px wide rather than the previous 280px: '+JSON.stringify(baseline));
  assert(baseline.stage.height>=710);assert(Math.abs(baseline.stage.width/baseline.stage.height-9/16)<.002);
  const focus=page.locator('#toggle-preview-focus');await focus.waitFor();assert.equal(await focus.getAttribute('aria-pressed'),'false');
  const frameToken='same-frame-'+Date.now();await frame.evaluate(value=>{window.previewSizeToken=value},frameToken);
  const identity=async()=>assert.equal(await frame.evaluate(()=>window.previewSizeToken),frameToken,'focus/resize must preserve the iframe document');
  const stamp=async()=>({state:await state(),calls:calls.length});
  const unchanged=async before=>{await delay(180);await identity();assert.deepEqual(await state(),before.state,'focus/resize does not mutate live state');assert.equal(calls.length,before.calls,'focus/resize does not request a new snapshot or publish');};
  const noOverflow=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'operator page has no horizontal overflow');
  const checkBounds=async(label)=>{
    const result=await measure(label);assert(!result.overflow,label+' horizontal overflow');
    assert(result.frame.width<=result.surround.width+1&&result.frame.height<=result.surround.height+1,label+' iframe stays within preview surround');
    assert(result.stage.width<=result.frame.width+1&&result.stage.height<=result.frame.height+1,label+' complete stage stays within iframe');
    assert(Math.abs(result.stage.width/result.stage.height-(result.stage.orientation==='portrait'?9/16:16/9))<.002,label+' exact aspect ratio');
    if(result.viewport.width>1040&&!result.focus){assert(result.left.height<=result.panel.height+1,label+' left column no taller than preview');assert(result.settings.bottom<=result.panel.bottom+1,label+' settings bottom within right column');}
    return result;
  };
  async function toggle(on){await focus.click();await until(()=>page.evaluate(value=>document.body.classList.contains('preview-focus')===value,on),'focus '+on);assert.equal(await focus.getAttribute('aria-pressed'),String(on));await delay(180)}
  let before=await stamp();await toggle(true);let focused=await checkBounds('1440 portrait focus');assert(Math.abs(focused.stage.width-640)<=5,'focus portrait canvas should grow to 640px');await unchanged(before);
  await page.locator('.preview-panel').screenshot({path:path.join(evidence,'preview-size-focus-portrait.png')});
  await focus.focus();await page.keyboard.press('Escape');await until(()=>page.evaluate(()=>!document.body.classList.contains('preview-focus')),'Escape exits focus');assert.equal(await focus.getAttribute('aria-pressed'),'false');await unchanged(before);
  checks.push('desktop portrait grows beyond 400px; focus increases further; same iframe; Escape; no preview/apply/live writes');
  await page.locator('.preview-panel').screenshot({path:path.join(evidence,'preview-size-default-portrait.png')});

  for(const [width,height] of [[1440,600],[768,1024],[390,844],[320,740]]){
    before=await stamp();await page.setViewportSize({width,height});await delay(220);await checkBounds(width+'x'+height+' portrait');await unchanged(before);
    await toggle(true);await checkBounds(width+'x'+height+' portrait focus');await unchanged(before);await toggle(false);await unchanged(before);
    await noOverflow();
    if(width===390)await page.screenshot({path:path.join(evidence,'preview-size-mobile.png'),fullPage:true});
  }
  checks.push('short desktop and 768/390/320 layouts preserve aspect ratio and avoid horizontal overflow');
  await page.setViewportSize({width:1440,height:900});await page.locator('button[data-orientation="landscape"]').click();await ready();
  let landscape=await checkBounds('1440 landscape');assert(landscape.stage.width>=700);assert.equal(landscape.orientation,'landscape');
  before=await stamp();await toggle(true);focused=await checkBounds('1440 landscape focus');assert(focused.stage.width>landscape.stage.width+50);await unchanged(before);
  await page.locator('.preview-panel').screenshot({path:path.join(evidence,'preview-size-focus-landscape.png')});await toggle(false);await unchanged(before);
  for(const width of [768,390,320]){before=await stamp();await page.setViewportSize({width,height:844});await delay(180);await checkBounds(width+' landscape');await unchanged(before);}
  assert.equal((await state()).revision,initial.revision,'draft direction and focus inspection never published');

  // Keep a real continuation page through a resize without rebuilding its document or changing the live snapshot.
  await page.setViewportSize({width:1440,height:900});await page.goto(base+'/control?script=script-08');await ready();
  frame=page.frames().find(item=>item.url().includes('preview=1'));await frame.evaluate(value=>window.previewSizeToken=value,frameToken);
  await page.locator('#preview-toolbar-placement').selectOption('outside');await page.locator('#layout-body-mode').selectOption('pages');await ready();
  const pageIndex=()=>frame.locator('.stage-page.is-current').getAttribute('data-page-index').then(Number);
  const pageCount=await frame.locator('.stage-page').count();assert(pageCount>3);
  for(let i=0;i<2;i++){await page.locator('[data-preview-external="next-page"]').click();await until(async()=>await pageIndex()===i+1,'select continuation page '+(i+1))}
  const settingsBefore={font:await page.locator('#layout-font').inputValue(),line:await page.locator('#layout-line').inputValue(),orientation:await frame.locator('.display-stage').getAttribute('class')};
  before=await stamp();await toggle(true);assert.equal(await pageIndex(),2);assert.equal(await frame.locator('.stage-page').count(),pageCount);await unchanged(before);
  // A user usually presses Escape while the keyboard focus is inside the interactive canvas.
  await frame.locator('.stage-page.is-current [data-anchor]').first().focus();assert.equal(await page.evaluate(()=>document.activeElement.id),'preview-frame','keyboard focus is inside the iframe');await page.keyboard.press('Escape');await until(()=>page.evaluate(()=>!document.body.classList.contains('preview-focus')),'Escape inside iframe exits focus');
  assert.equal(await pageIndex(),2);await unchanged(before);
  assert.deepEqual({font:await page.locator('#layout-font').inputValue(),line:await page.locator('#layout-line').inputValue(),orientation:await frame.locator('.display-stage').getAttribute('class')},settingsBefore);
  checks.push('continuation page, count, draft font, line height and orientation survive focus; iframe Escape works');

  await page.locator('#preview-feedback-mode').selectOption('realtime');await until(async()=> (await state()).mode==='script'&&(await state()).page_index===2,'realtime baseline applied');await ready();await delay(300);
  before=await stamp();await toggle(true);await toggle(false);assert.equal(await pageIndex(),2);await unchanged(before);
  checks.push('focus also causes no state/apply/preview change while realtime feedback is active');
  await page.locator('#preview-feedback-mode').selectOption('confirm');

  // Media keeps its actual native currentTime, selected caption, and playback element through focus.
  const lib=await library();const upload=await context.request.post(base+'/api/scripts/script-08/media',{headers:{'X-CSRF-Token':lib.csrf_token},multipart:{file:{name:'preview-size.wav',mimeType:'audio/wav',buffer:wav()}}});assert(upload.ok(),await upload.text());
  const linked=await upload.json(),textBlocks=linked.blocks.filter(block=>block.kind==='text');
  await send('/api/scripts/script-08/media/cues',{duration:12,cues:[{id:'sizing-cue-1',at:2,label:'台词一',block_ids:[textBlocks[0].id]},{id:'sizing-cue-2',at:6,label:'台词二',block_ids:[textBlocks[1].id]}]},'PUT');
  await page.goto(base+'/control?script=script-08&body=media');await ready();frame=page.frames().find(item=>item.url().includes('preview=1'));
  await frame.locator('.wb-media-player').waitFor();await frame.waitForFunction(()=>document.querySelector('.wb-media-element').readyState>=2);
  await frame.evaluate(value=>{window.previewSizeToken=value;window.previewSizeMedia=document.querySelector('.wb-media-element')},frameToken);
  await frame.locator('.wb-media-player').hover();const progress=frame.locator('.wb-media-progress');await progress.fill('4.25');await progress.dispatchEvent('input');await progress.dispatchEvent('change');
  const mediaState=()=>frame.locator('.wb-media-element').evaluate(element=>({position:element.currentTime,paused:element.paused,same:element===window.previewSizeMedia,caption:document.querySelector('.wb-media-caption-label').textContent}));
  await until(async()=>Math.abs((await mediaState()).position-4.25)<.02,'paused preview position');
  const mediaBefore=await mediaState();before=await stamp();await toggle(true);assert.deepEqual(await mediaState(),mediaBefore);await unchanged(before);
  await frame.locator('.wb-media-caption-scroll').focus();await page.keyboard.press('Escape');await until(()=>page.evaluate(()=>!document.body.classList.contains('preview-focus')),'media iframe Escape exits focus');
  assert.deepEqual(await mediaState(),mediaBefore);await unchanged(before);
  await page.locator('.preview-panel').screenshot({path:path.join(evidence,'preview-size-media.png')});
  checks.push('media element identity, paused 4.25s position and caption survive focus and iframe Escape');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,'preview-size-result.json'),JSON.stringify({passed:true,errors,sizes,checks},null,2));
  console.log('Preview size acceptance passed: '+checks.join('; '));
})().catch(async error=>{
  console.error(error);process.exitCode=1;await fs.mkdir(evidence,{recursive:true});
  await fs.writeFile(path.join(evidence,'preview-size-result.json'),JSON.stringify({passed:false,error:error.stack,errors,sizes,checks},null,2));
  if(page)try{await page.screenshot({path:path.join(evidence,'preview-size-failure.png'),fullPage:true})}catch{}
}).finally(async()=>{await browser?.close();if(child)try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{child.kill()}});
