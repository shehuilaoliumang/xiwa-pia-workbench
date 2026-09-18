const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','pagination-'+Date.now()),base='http://127.0.0.1:8898';
let browser,child,page,display;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let i=0;i<160;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
 child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8898','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
 await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'server');
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 const context=await browser.newContext({viewport:{width:1600,height:1120}}),errors=[],audits=[];
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const lib=async()=> (await context.request.get(base+'/api/library')).json();
 const state=async()=> (await context.request.get(base+'/api/state')).json();
 const send=async(url,body,method='POST')=>{const l=await lib();const r=await context.request.fetch(base+url,{method,data:body,headers:{'X-CSRF-Token':l.csrf_token}});assert(r.ok(),await r.text());return r.json()};
 const initial=await lib(),image=initial.scripts.flatMap(s=>s.blocks||[]).find(b=>b.kind==='image');assert(image);
 const category=await send('/api/categories',{name:'分页与悬停验收',description:'长段落、行内颜色与图片的来源保真',color:'#775544'});
 const red='前半段：保留原色与标点。春风拂过河面，我们继续这个长篇故事。🌸👩‍🎤\n'.repeat(85);
 const green='后半段：同一段落跨越多页，文字不能遗漏，也不能重复。🎭 e\u0301\n'.repeat(65);
 let fixture=await send('/api/scripts',{title:'分页保真验收',category_id:category.id,author:'测试作者',synopsis:'用于实际排版测量的独立测试资料',cast_note:'甲乙二人',blocks:[
 {kind:'text',role:'甲',text:red+green,runs:[{text:red,color:'#8C424E'},{text:green,color:'#3D6C61'}]},
 {kind:'text',role:'乙',text:'短段一：这是另一位角色的回应。\n第二行仍属于同一段。',color:'#4C5D85'},
 {kind:'image',image_path:image.image_path,text:'插图一'},
 {kind:'text',role:'甲',text:'第二个长段。不同字号和横竖画幅应重新分页。\n'.repeat(95),color:'#705080'},
 {kind:'image',image_path:image.image_path,text:'插图二'},
 {kind:'text',text:'结尾：全文与两张插图均必须保留。'}]});
 fixture=await send('/api/scripts/'+fixture.id,{blocks:fixture.blocks.map((block,index)=>index===0?{...block,runs:[{text:red,color:'#8C424E'},{text:green,color:'#3D6C61'}]}:block)},'PATCH');
 page=await context.newPage();await page.goto(base+'/control?script='+fixture.id);
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#apply-display').disabled);
 await ready();const frame=page.frames().find(f=>f.url().includes('preview=1'));
 const ext=a=>page.locator(`[data-preview-external="${a}"]`);
 await page.locator('#preview-toolbar-placement').selectOption('outside');
 await page.locator('#layout-body-mode').selectOption('pages');await ready();
 const current=f=>f.locator('.stage-page.is-current').getAttribute('data-page-index').then(Number);
 const count=f=>f.locator('.stage-page').count();
 async function audit(label){
  if(!await frame.locator('.stage-page.is-current').count())throw Error(label+': '+await frame.locator('#stage-footer-text').innerText());
  await frame.locator('.stage-page.is-current').waitFor();
  const result=await frame.evaluate(()=>{
   const out={texts:{},colors:{},images:0,overflows:[],bounds:{},pageCount:document.querySelectorAll('.stage-page').length};
   for(const pg of document.querySelectorAll('.stage-page')){
    const hidden=pg.hidden,display=pg.style.display;pg.hidden=false;pg.style.display='block';
    const body=pg.querySelector('.stage-page-body');if(body.scrollHeight>body.clientHeight+1)out.overflows.push({page:pg.dataset.pageIndex,height:body.clientHeight,scroll:body.scrollHeight});
    for(const node of pg.querySelectorAll('[data-anchor]')){
     const id=node.dataset.anchor,txt=node.querySelector('.block-text');
     if(txt){(out.texts[id]??=[]).push(txt.textContent);(out.bounds[id]??=[]).push([Number(node.dataset.sourceStart),Number(node.dataset.sourceEnd)]);for(const span of txt.querySelectorAll('span'))(out.colors[id]??=[]).push({text:span.textContent,color:span.style.color})}
     else if(node.querySelector('img')){out.images++;const im=node.querySelector('img');const ir=im.getBoundingClientRect(),br=body.getBoundingClientRect();if(ir.height<=0||ir.bottom>br.bottom+1)out.overflows.push({page:pg.dataset.pageIndex,image:ir.height,bottom:ir.bottom-br.bottom});}
    }
    pg.hidden=hidden;pg.style.display=display;
   }
   return out;
  });
  assert.equal(result.images,2,label+' image count');assert.deepEqual(result.overflows,[],label+' overflow');
  for(const block of fixture.blocks.filter(b=>b.kind==='text')){
   assert.equal(result.texts[block.id].join(''),block.text,label+' exact text '+block.id);
   let end=0;for(const[start,next]of result.bounds[block.id]){assert.equal(start,end);assert(next>=start);end=next}assert.equal(end,block.text.length);
  }
  const runs=result.colors[fixture.blocks[0].id],merged=[];for(const run of runs){if(merged.at(-1)?.color===run.color)merged.at(-1).text+=run.text;else merged.push({...run})}
  assert.deepEqual(merged,[{text:red,color:'rgb(140, 66, 78)'},{text:green,color:'rgb(61, 108, 97)'}],label+' inline source colors');
  assert(result.pageCount>3);audits.push({label,pages:result.pageCount,images:result.images});return result;
 }
 await audit('portrait');await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa','browser','pagination-portrait.png')});assert(await ext('play').isDisabled());
 const firstId=fixture.blocks[0].id;
 const crossPages=await frame.locator(`.stage-page:has([data-anchor="${firstId}"])`).evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.pageIndex)));
 assert(crossPages.length>2);const target=crossPages[2];
 for(let i=0;i<target;i++){await ext('next-page').click();await until(async()=> (await current(frame))===i+1,'local next page '+(i+1));}assert.equal(await current(frame),target);
 await frame.locator(`.stage-page.is-current [data-anchor="${firstId}"]`).click();
 assert.equal(await current(frame),target,'click on continuation must keep its page');assert.equal(await frame.locator('.stage-page.is-current .preview-selected').count(),1);
 await page.locator('#apply-display').click();await until(async()=> (await state()).page_index===target,'confirm exact continuation page');await ready();
 const popup=context.waitForEvent('page');await page.locator('#open-display').click();display=await popup;await display.waitForLoadState();await display.locator('.stage-page.is-current').waitFor();
 await until(async()=> (await current(display))===target,'audience exact page on open');await page.bringToFront();
 const token=(await lib()).csrf_token;
 const rejected=await context.request.post(base+'/api/command',{data:{action:'play'},headers:{'X-CSRF-Token':token}});assert.equal(rejected.status(),400);assert.equal((await rejected.json()).code,'paged_display');
 const beforeConfirm=await state();await ext('next-page').click();await delay(300);assert.equal((await state()).revision,beforeConfirm.revision,'confirm page changes isolated');
 await page.locator('#preview-feedback-mode').selectOption('realtime');await until(async()=> (await state()).page_index===target+1,'realtime uses current continuation page');await ready();
 await ext('next-page').click();await until(async()=> (await state()).page_index===target+2,'realtime next page');await until(async()=> (await current(display))===target+2,'audience next page');
 await ext('previous-page').click();await until(async()=> (await state()).page_index===target+1,'realtime previous page');await ready();
 await page.locator('.live-details').evaluate(e=>e.open=true);await until(()=>page.locator('#live-next-page').isEnabled(),'live page control ready');await page.locator('#live-next-page').click();await until(async()=> (await state()).page_index===target+2,'live page command');await until(async()=> (await current(frame))===target+2,'live page follows in preview');
 await page.locator('.preview-panel').scrollIntoViewIfNeeded();await frame.locator(`.stage-page.is-current [data-anchor="${firstId}"]`).hover();
 await until(async()=> (await display.locator(`.stage-page.is-current [data-anchor="${firstId}"].content-hover`).count())===1,'body hover sync on continuation');
 await frame.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))});await delay(350);
 await page.locator('#live-next-page').click();const resumedPage=target+3;await until(async()=> (await state()).page_index===resumedPage,'page changes while preview hidden');
 await frame.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))});await until(async()=> (await current(frame))===resumedPage,'visibility restores exact page');
 await frame.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'))});
 await page.locator('#preview-feedback-mode').selectOption('confirm');
 await page.locator('[data-orientation=landscape]').click();await ready();await page.locator('#layout-body-mode').selectOption('pages');await ready();await audit('landscape');await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa','browser','pagination-landscape.png')});
 await page.locator('#layout-font').fill('64');await page.locator('#layout-font').dispatchEvent('input');await ready();await audit('landscape font64');
 await page.locator('#layout-font').fill('96');await page.locator('#layout-font').dispatchEvent('input');await page.locator('#layout-line').fill('3');await page.locator('#layout-line').dispatchEvent('input');await page.locator('#layout-padding').fill('200');await page.locator('#layout-padding').dispatchEvent('input');await ready();await audit('max font line padding');
 await page.locator('#layout-font').fill('36');await page.locator('#layout-font').dispatchEvent('input');await page.locator('#layout-line').fill('1.8');await page.locator('#layout-line').dispatchEvent('input');await page.locator('#layout-padding').fill('72');await page.locator('#layout-padding').dispatchEvent('input');await ready();await audit('reflow normal');await page.locator('.preview-panel').screenshot({path:path.join(root,'.qa','browser','pagination-reflow.png')});
 await ext('return-list').click();await frame.locator('.stage-list').waitFor();await ready();await page.locator('#preview-feedback-mode').selectOption('realtime');await until(async()=> (await state()).mode==='list','list realtime');await ready();
 await page.locator('.preview-panel').scrollIntoViewIfNeeded();await frame.locator(`[data-preview-script="${fixture.id}"]`).hover();await until(async()=> (await display.locator(`[data-anchor="script:${fixture.id}"].content-hover`).count())===1,'script card hover sync');
 await ext('return-list').click();await frame.locator('[data-preview-category]').first().waitFor();await ready();await page.locator('#layout-category-columns').selectOption('1');await ready();
 await page.locator('.preview-panel').scrollIntoViewIfNeeded();const card=frame.locator(`[data-preview-category="${category.id}"]`);await card.hover();
 await until(async()=> (await display.locator(`[data-anchor="category:${category.id}"].content-hover`).count())===1,'category hover sync');
 const transforms=await Promise.all([card.evaluate(e=>getComputedStyle(e).transform),display.locator(`[data-anchor="category:${category.id}"]`).evaluate(e=>getComputedStyle(e).transform)]);assert(transforms.every(t=>t!=='none'));
 await page.locator('#preview-feedback-mode').selectOption('confirm');await delay(400);assert.equal(await display.locator('.content-hover').count(),0,'confirmation clears audience hover');
 await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});await fs.writeFile(path.join(root,'.qa','browser','pagination-result.json'),JSON.stringify({passed:true,browserErrors:errors,audits,checks:['measured page overflow','exact text offsets including graphemes','source colors','images retained','continuation click and confirmation apply','realtime and live page controls','pages play rejected','all content hover','page visibility recovery','orientation and font reflow']},null,2));
 assert.deepEqual(errors,[]);console.log('Pagination browser acceptance passed:',JSON.stringify(audits));
})().catch(async e=>{console.error(e);if(page)try{await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});await page.screenshot({path:path.join(root,'.qa','browser','pagination-failure.png'),fullPage:true})}catch{}process.exitCode=1}).finally(async()=>{if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill()});
