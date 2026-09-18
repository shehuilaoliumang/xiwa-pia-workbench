const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','media-caption-sync-'+Date.now()),base='http://127.0.0.1:8908',evidence=path.join(root,'.qa/browser');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<180;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
function wav(seconds=12){const rate=8000,n=seconds*rate,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b}
let browser,child,page,audience;const errors=[],checks=[],audits=[];
(async()=>{
 await fs.mkdir(evidence,{recursive:true});
 child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8908','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
 await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
 const library=async()=>(await context.request.get(base+'/api/library')).json(),state=async()=>(await context.request.get(base+'/api/state')).json();
 const send=async(url,body,method='POST')=>{const lib=await library(),response=await context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':lib.csrf_token}});assert(response.ok(),await response.text());return response.json()};
 const lib=await library(),sourceImage=lib.scripts.flatMap(script=>script.blocks).find(block=>block.kind==='image');assert(sourceImage);
 const first='甲：雨落在旧城的石板路上，我们站在剧场门口，一起回忆曾经的故事。🌧️\n'.repeat(30),second='乙：长台词跨页时必须完整保留，颜色、标点、换行不能丢失。🎭 e\u0301\n'.repeat(28);
 let fixture=await send('/api/scripts',{title:'媒体组内分页同步验收',category_id:'cat-sweet',cast_note:'两人',blocks:[{kind:'text',role:'甲',text:first+second,runs:[{text:first,color:'#72262F'},{text:second,color:'#18605A'}]},{kind:'image',text:'原稿图片',image_path:sourceImage.image_path},{kind:'text',role:'乙',text:'同组收尾。图文顺序与完整内容都应该保留。'},{kind:'text',role:'甲',text:'第二组短台词。'}]});
 fixture=await send('/api/scripts/'+fixture.id,{blocks:fixture.blocks.map((block,index)=>index===0?{...block,runs:[{text:first,color:'#72262F'},{text:second,color:'#18605A'}]}:block)},'PATCH');
 const upload=await context.request.post(base+'/api/scripts/'+fixture.id+'/media',{headers:{'X-CSRF-Token':lib.csrf_token},multipart:{file:{name:'caption-sync.wav',mimeType:'audio/wav',buffer:wav()}}});assert(upload.ok(),await upload.text());
 await send('/api/scripts/'+fixture.id+'/media/cues',{duration:12,cues:[{id:'caption-cue-1',at:.5,label:'长台词组',block_ids:fixture.blocks.slice(0,3).map(block=>block.id)},{id:'caption-cue-2',at:8,label:'短台词组',block_ids:[fixture.blocks[3].id]}]},'PUT');
 page=await context.newPage();const applies=[];
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/apply')applies.push(request.postDataJSON())});
 await page.goto(base+'/control?script='+fixture.id+'&body=media');
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);await ready();
 let frame=page.frames().find(item=>item.url().includes('preview=1'));
 const pageIndex=f=>f.locator('.pia-media-caption-page.is-current').getAttribute('data-caption-page-index').then(Number),pageCount=f=>f.locator('.pia-media-caption-page').count();
 const pagingReady=async(f=frame)=>{await until(async()=>await f.locator('.pia-media-caption-page.is-current').count()===1&&await pageCount(f)>0,'caption pagination ready');await until(async()=>!/正在/.test(await f.locator('.pia-media-page-label').textContent()),'caption pages settled')};
 const media=f=>f.locator('.pia-media-element'),mediaState=f=>media(f).evaluate(element=>({position:element.currentTime,paused:element.paused}));
 const ext=action=>page.locator('[data-preview-external="'+action+'"]');
 const internal=(action,f=frame)=>f.locator('[data-media-action="'+action+'"]');
 const press=async key=>{await frame.locator('.pia-media-caption-scroll').focus();await page.keyboard.press(key)};
 const seek=async seconds=>{await frame.locator('.pia-media-player').hover();const range=frame.locator('.pia-media-progress');await range.fill(String(seconds));await range.dispatchEvent('input');await range.dispatchEvent('change');await until(async()=>Math.abs((await mediaState(frame)).position-seconds)<.02,'media seek '+seconds)};
 async function audit(label,f=frame){
  await pagingReady(f);const result=await f.evaluate(()=>{
   const pages=[...document.querySelectorAll('.pia-media-caption-page')],texts={},ranges={},colors={},overflows=[];let images=0;
   for(const page of pages){const hidden=page.hidden;page.hidden=false;const rect=page.getBoundingClientRect();if(page.scrollHeight>page.clientHeight+1)overflows.push({index:page.dataset.captionPageIndex,scroll:page.scrollHeight,height:page.clientHeight});
    for(const block of page.querySelectorAll('[data-block-id]')){const id=block.dataset.blockId,text=block.querySelector('.pia-media-block-text');if(text){(texts[id]??=[]).push(text.textContent);(ranges[id]??=[]).push([Number(block.dataset.sourceStart),Number(block.dataset.sourceEnd)]);for(const run of text.querySelectorAll('span'))(colors[id]??=[]).push({text:run.textContent,color:run.style.color})}images+=block.querySelectorAll('img').length;}page.hidden=hidden;
   }
   return {pages:pages.length,texts,ranges,colors,images,overflows};
  });
  assert(result.pages>=3,label+' has at least 3 pages');assert.equal(result.images,1,label+' keeps image once');assert.deepEqual(result.overflows,[],label+' page body fits');
  for(const block of fixture.blocks.slice(0,3).filter(block=>block.kind==='text'))assert.equal((result.texts[block.id]||[]).join(''),block.text,label+' preserves exact text '+block.id);
  const merged=[];for(const run of result.colors[fixture.blocks[0].id]||[]){if(merged.at(-1)?.color===run.color)merged.at(-1).text+=run.text;else merged.push({...run})}
  assert.deepEqual(merged,[{text:first,color:'rgb(114, 38, 47)'},{text:second,color:'rgb(24, 96, 90)'}],label+' keeps run text and color');
  audits.push({label,pages:result.pages,images:result.images});return result;
 }
 await pagingReady();assert.equal(await page.locator('#layout-media-caption-layout').inputValue(),'pages');await page.locator('#preview-toolbar-placement').selectOption('outside');await audit('portrait initial');
 const initial=await state();await seek(1.25);const paused=await mediaState(frame);assert(paused.paused);
 await internal('next-caption-page').click();await until(async()=>await pageIndex(frame)===1,'in-frame next caption page');assert.deepEqual(await mediaState(frame),paused);
 await press('ArrowRight');await until(async()=>await pageIndex(frame)===2,'right next caption page');assert.deepEqual(await mediaState(frame),paused);
 await press('ArrowLeft');await until(async()=>await pageIndex(frame)===1,'left previous caption page');
 await ext('previous-page').click();await until(async()=>await pageIndex(frame)===0,'external previous caption page');
 assert(await ext('previous-page').isDisabled());await press('ArrowLeft');await delay(120);assert.equal(await pageIndex(frame),0);assert.deepEqual(await mediaState(frame),paused);
 const total=await pageCount(frame);for(let i=1;i<total;i++){await ext('next-page').click();await until(async()=>await pageIndex(frame)===i,'external page '+i)}
 assert(await ext('next-page').isDisabled());await press('ArrowRight');await delay(120);assert.equal(await pageIndex(frame),total-1);assert.deepEqual(await mediaState(frame),paused);
 assert.deepEqual(await state(),initial);assert.equal(applies.length,0);checks.push('in-frame/external/left-right paging and boundaries preserve media time; confirmation never publishes');

 await press('ArrowDown');await pagingReady();assert.equal(await pageIndex(frame),0);assert.equal(await pageCount(frame),1);assert.equal(await frame.locator('.pia-media-block-text').textContent(),fixture.blocks[3].text);assert.deepEqual(await mediaState(frame),paused);
 await press('ArrowUp');await pagingReady();assert.equal(await pageIndex(frame),0);await audit('group return');checks.push('up/down switches cue group and resets to first caption page without seeking media');
 await frame.locator('.pia-media-player').hover();await internal('play').click();await until(async()=>!(await mediaState(frame)).paused,'preview media playing');const started=(await mediaState(frame)).position;
 await ext('next-page').click();await until(async()=>await pageIndex(frame)===1,'paging while playing');assert(!(await mediaState(frame)).paused);await until(async()=> (await mediaState(frame)).position>started+.08,'native time continues across caption page');await frame.locator('.pia-media-player').hover();await internal('play').click();await seek(1.25);
 checks.push('turning a caption page does not pause or restart native media playback');
 await pagingReady();if(await pageIndex(frame)!==1){while(await pageIndex(frame)>1)await ext('previous-page').click();while(await pageIndex(frame)<1)await ext('next-page').click()}
 await page.locator('#apply-display').click();await until(async()=> (await state()).media_state?.caption_page_index===1,'confirm apply carries caption page');await ready();
 assert.equal(applies.at(-1).preview_media_state.caption_page_index,1);assert(!(await state()).playing);
 const popup=context.waitForEvent('page');await page.locator('#open-display').click();audience=await popup;await audience.waitForLoadState();await pagingReady(audience);await until(async()=>await pageIndex(audience)===1,'audience current page restored');await page.bringToFront();
 const currentText=f=>f.locator('.pia-media-caption-page.is-current .pia-media-block-text').allTextContents();
 assert.deepEqual(await currentText(audience),await currentText(frame),'same page index has the same text across preview and audience scale');
 checks.push('confirmation apply includes caption page; independent audience opens to the same page and text');

 await page.locator('#preview-feedback-mode').selectOption('realtime');await ready();await until(async()=> (await state()).media_state?.caption_page_index===1,'realtime binding');await delay(300);
 const beforeApply=applies.length,beforeRevision=(await state()).revision;await ext('next-page').click();await until(async()=> (await state()).media_state?.caption_page_index===2,'realtime caption page persisted');await until(async()=>await pageIndex(audience)===2,'audience follows realtime caption page');await delay(350);
 assert.equal(applies.length-beforeApply,1,'one caption flip produces one realtime apply');assert.equal((await state()).revision,beforeRevision+1);assert.deepEqual(await currentText(audience),await currentText(frame));
 await audience.reload();await pagingReady(audience);await until(async()=>await pageIndex(audience)===2,'audience reload preserves caption page');assert(!(await state()).playing);assert((await mediaState(audience)).paused);await page.bringToFront();
 await until(async()=>await pageIndex(frame)===2,'preview keeps page after audience reconnect');
 checks.push('realtime flip applies once and matches audience; audience reload preserves page and pauses');
 await page.locator('#preview-feedback-mode').selectOption('confirm');const frozen=await state();
 await page.locator('#toggle-preview-focus').click();await until(()=>page.evaluate(()=>document.body.classList.contains('preview-focus')),'focus enabled');await audit('portrait focused');assert.equal(await pageIndex(frame),2);assert.deepEqual(await state(),frozen);await page.locator('#toggle-preview-focus').click();await audit('portrait focus restored');
 await page.locator('button[data-orientation="landscape"]').click();await ready();await audit('landscape');assert.deepEqual(await state(),frozen);
 await page.locator('.preview-panel').screenshot({path:path.join(evidence,'media-caption-landscape.png')});
 await page.locator('button[data-orientation="portrait"]').click();await ready();await audit('portrait return');await page.locator('.preview-panel').screenshot({path:path.join(evidence,'media-caption-portrait.png')});
 checks.push('focus and orientation changes retain complete text/runs/image and valid pages without publishing confirmation draft');

 await page.locator('#layout-media-caption-layout').selectOption('scroll');await ready();await until(async()=>await frame.locator('.pia-media-caption-page').count()===0,'scroll mode');assert(await ext('next-page').isHidden());assert(await internal('next-caption-page').isHidden());
 const scrollTexts=await frame.locator('.pia-media-block-text').allTextContents();assert.deepEqual(scrollTexts,fixture.blocks.slice(0,3).filter(block=>block.kind==='text').map(block=>block.text));
 await press('ArrowRight');await until(async()=>await frame.locator('.pia-media-block-text').count()===1&&(await frame.locator('.pia-media-block-text').textContent())===fixture.blocks[3].text,'scroll right moves group');await press('ArrowLeft');await until(async()=>await frame.locator('.pia-media-block-text').count()===2,'scroll left returns group');
 await page.locator('#layout-preset-name').fill('媒体组内连续滚动方案');await page.locator('#new-layout-preset').click();await until(async()=> (await library()).layout_presets.some(preset=>preset.name==='媒体组内连续滚动方案'),'preset saved');
 const saved=(await library()).layout_presets.find(preset=>preset.name==='媒体组内连续滚动方案');assert.equal(saved.layouts.portrait.media_caption_layout,'scroll');assert.equal(saved.layouts.landscape.media_caption_layout,'pages');
 await page.locator('#layout-media-caption-layout').selectOption('pages');await ready();await pagingReady();await page.locator('#layout-preset').selectOption(saved.id);await page.locator('#load-layout-preset').click();await ready();assert.equal(await page.locator('#layout-media-caption-layout').inputValue(),'scroll');assert.equal(await frame.locator('.pia-media-caption-page').count(),0);
 await page.locator('#save-layout').click();await until(async()=> (await library()).layouts.portrait.media_caption_layout==='scroll','current portrait saved');assert.deepEqual(await state(),frozen);
 checks.push('scroll layout restores full group and group arrow keys; presets retain both directions and load as draft; save layout does not publish');
 await page.setViewportSize({width:390,height:844});await page.locator('#layout-media-caption-layout').selectOption('pages');await ready();await audit('390 portrait');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('.preview-panel').screenshot({path:path.join(evidence,'media-caption-mobile.png')});
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(evidence,'media-caption-sync-result.json'),JSON.stringify({passed:true,errors,checks,audits},null,2));console.log('Media caption sync passed: '+checks.join('; '));
})().catch(async error=>{console.error(error);process.exitCode=1;await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'media-caption-sync-result.json'),JSON.stringify({passed:false,error:error.stack,errors,checks,audits},null,2));if(page)try{await page.screenshot({path:path.join(evidence,'media-caption-sync-failure.png'),fullPage:true})}catch{}}).finally(async()=>{await browser?.close();if(child)try{execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true})}catch{child.kill()}});
