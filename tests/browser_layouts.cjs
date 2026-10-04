const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const base=process.argv[2]||'http://127.0.0.1:8877';
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext();const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let library=await(await context.request.get(base+'/api/library')).json();
  const token=library.csrf_token;
  const write=async(route,body,method='POST')=>{const r=await context.request.fetch(base+route,{method,data:body,headers:{'X-CSRF-Token':token}});assert(r.ok(),await r.text());return r.json()};
  let categories=library.categories.filter(c=>c.id!=='uncategorized');
  for(let i=categories.length;i<30;i++)categories.push(await write('/api/categories',{name:`排列验收 ${i+1}：这是用于检查自适应的较长分组名称`,visible:true}));
  await fs.mkdir('.qa/browser',{recursive:true});
  for(const count of [0,1,6,12,30]){
    for(let i=0;i<categories.length;i++)await write('/api/categories/'+categories[i].id,{visible:i<count},'PATCH');
    for(const width of [390,1440]){
      await page.setViewportSize({width,height:900});await page.goto(base+'/');await page.waitForTimeout(250);
      assert.equal(await page.locator('#category-filters [data-category]').count(),count+1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`catalog overflow ${count} / ${width}`);
      await page.locator('#category-filters button').last().scrollIntoViewIfNeeded();
      await page.screenshot({path:`.qa/browser/categories-${count}-${width}.png`});
    }
  }
  for(const route of ['/manage','/control','/script/script-01']){
    await page.setViewportSize({width:390,height:844});await page.goto(base+route);await page.waitForTimeout(400);
    if(route==='/manage')await page.locator('#tab-categories').click();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile overflow '+route);
    await page.screenshot({path:'.qa/browser/layout-'+route.replaceAll('/','-')+'.png',fullPage:true});
  }
  assert.deepEqual(errors,[]);await browser.close();console.log('Category layout acceptance passed: 0/1/6/12/30, long names, mobile and desktop, manager/controller/reader mobile.');
})().catch(e=>{console.error(e);process.exit(1)});
