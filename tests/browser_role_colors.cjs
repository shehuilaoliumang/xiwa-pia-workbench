const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','role-colors-'+Date.now()),base='http://127.0.0.1:8893';
let browser,child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8893','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const lib=async()=> (await context.request.get(base+'/api/library')).json();
  const initial=await lib(),headers={'X-CSRF-Token':initial.csrf_token};
  const blocks=[
    {kind:'text',role:'甲',color:'#aa1122',text:'甲：首个配色台词。'},
    {kind:'text',role:'甲',color:'#4477aa',text:'甲：此段有自己的其他颜色。'},
    {kind:'text',role:'乙',color:'#1122aa',text:'乙：已有蓝色台词。'},
    {kind:'text',role:'仅行内色',color:'#22aa44',text:'只有行内绿色。'},
    {kind:'text',role:'旧名',color:'#663399',text:'前半后半'},
    {kind:'text',role:'别名',color:'#aa1122',text:'保留强调颜色'}
  ];
  let response=await context.request.post(base+'/api/scripts',{headers,data:{title:'角色配色专项',category_id:initial.categories[0].id,blocks}});
  assert(response.ok(),await response.text());
  const fixture=(await lib()).scripts.find(item=>item.title==='角色配色专项');assert(fixture);
  fixture.blocks[3].runs=[{text:fixture.blocks[3].text,color:'#22aa44'}];
  fixture.blocks[4].runs=[{text:'前半',color:'#663399'},{text:'后半',color:'#1122aa',bold:true}];
  fixture.blocks[5].runs=[{text:'保留',color:'#aa1122'},{text:'强调颜色',color:'#445566',bold:true}];
  response=await context.request.patch(base+'/api/scripts/'+fixture.id,{headers,data:{blocks:fixture.blocks}});assert(response.ok(),await response.text());
  // A legacy paragraph may have run colours without its own base colour.
  execFileSync(python,['-X','utf8','-c',"import sys,sqlite3,json\nc=sqlite3.connect(sys.argv[1])\ns=json.loads(c.execute('select data from scripts where id=?',(sys.argv[2],)).fetchone()[0])\ns['blocks'][3]['color']=''\nc.execute('update scripts set data=? where id=?',(json.dumps(s,ensure_ascii=False),sys.argv[2]))\nc.commit()",path.join(data,'workbench.sqlite3'),fixture.id],{cwd:root,windowsHide:true});
  const original=(await lib()).scripts.find(item=>item.id===fixture.id);
  await page.goto(base+'/manage');await page.waitForFunction(()=>typeof window.piaEditor?.getDraft==='function');
  await page.locator(`[data-edit-script="${fixture.id}"]`).click();await page.locator('#body-editor-details').evaluate(element=>{element.open=true});
  const draft=()=>page.evaluate(()=>window.piaEditor.getDraft());
  const picker=index=>page.locator(`[data-block-color="${index}"]`),role=index=>page.locator(`[data-block-role="${index}"]`);
  const text=index=>page.locator(`[data-block-text="${index}"]`);
  const added=async()=>{await page.locator('#add-block').click();return (await draft()).blocks.length-1};
  const setColor=async(index,value)=>picker(index).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},value);
  const sourceBefore=await draft();assert.deepEqual(sourceBefore.blocks,original.blocks,'opening the editor preserves every existing paragraph');
  let index=await added();await text(index).fill('甲：新添加的完整台词。');await role(index).fill('甲');
  let current=await draft();assert.equal(current.blocks[index].color,'#aa1122');assert.equal(await picker(index).inputValue(),'#aa1122');
  assert.deepEqual(current.blocks[index].runs,[{text:'甲：新添加的完整台词。',color:'#aa1122'}],'existing runs cannot mask the inherited colour');
  const manualIndex=index;await setColor(index,'#11bbcc');await role(index).dispatchEvent('change');
  assert.equal((await draft()).blocks[index].color,'#11bbcc','blur/change following manual recolouring does not rebind unchanged role');
  await role(index).fill('全新角色');assert.equal((await draft()).blocks[index].color,'#11bbcc','unmatched new roles preserve chosen colour');
  index=await added();await role(index).fill('乙');await text(index).fill('乙：先选择角色再输入文字。');
  assert.deepEqual((await draft()).blocks[index].runs,[{text:'乙：先选择角色再输入文字。',color:'#1122aa'}]);
  index=await added();await text(index).fill('绿色后备色台词。');await role(index).evaluate(input=>{input.value='仅行内色';input.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal((await draft()).blocks[index].color,'#22aa44','change-only selection and run-only source colours are supported');
  index=await added();await text(index).fill('中文输入法提交。');await role(index).evaluate(input=>{input.value='乙';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
  assert.equal((await draft()).blocks[index].role,'','in-progress IME does not prematurely match a role');
  await role(index).dispatchEvent('compositionend');assert.equal((await draft()).blocks[index].color,'#1122aa');
  await role(4).fill('乙');current=await draft();assert.equal(current.blocks[4].color,'#1122aa');
  assert.deepEqual(current.blocks[4].runs,[{text:'前半后半',color:'#1122aa'}],'changing to a differently coloured role colours the whole selected sentence');
  await role(5).fill('甲');current=await draft();assert.deepEqual(current.blocks[5].runs,sourceBefore.blocks[5].runs,'matching base colours preserve authored inline emphasis');
  await role(5).dispatchEvent('change');assert.deepEqual((await draft()).blocks[5].runs,sourceBefore.blocks[5].runs);
  assert.deepEqual(current.blocks.slice(0,4),sourceBefore.blocks.slice(0,4),'role binding never recolours other paragraphs');
  assert.deepEqual((await lib()).scripts.find(item=>item.id===fixture.id).blocks,original.blocks,'all changes remain draft-only before save');
  await page.locator('#script-form button[type="submit"]').click();await page.locator('#script-dialog').waitFor({state:'hidden'});
  const saved=(await lib()).scripts.find(item=>item.id===fixture.id);
  assert.equal(saved.blocks[manualIndex].color,'#11bbcc');assert.equal(saved.blocks[4].color,'#1122aa');
  assert.deepEqual(saved.blocks[5].runs,sourceBefore.blocks[5].runs,'saved unchanged text preserves original inline colours and bold');
  assert.equal(saved.blocks[index].color,'#1122aa');assert.equal(saved.blocks[index].text,'中文输入法提交。');
  await page.goto(base+'/script/'+fixture.id);
  assert.equal(await page.locator(`[id="${saved.blocks[4].id}"] .block-text span`).evaluate(element=>getComputedStyle(element).color),'rgb(17, 34, 170)','reader displays the inherited sentence colour');
  assert.deepEqual(errors,[]);
  await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});
  await fs.writeFile(path.join(root,'.qa','browser','role-colors-result.json'),JSON.stringify({passed:true,browserErrors:errors,checks:[
    'existing role input inherits first valid colour despite same-name source variations','dialogue typed before or after role selection follows the role colour',
    'change-only and IME commit work','run-only source colour fallback','manual override survives subsequent unchanged role events','new roles retain manual colour',
    'different role colour replaces masking runs only on the selected sentence','same role colour retains original inline colours and emphasis',
    'other source paragraphs are unchanged','draft changes require save','saved colour is displayed by the reader'
  ]},null,2));
  console.log('Role colour browser acceptance passed: inheritance, runs, manual override, change and IME, draft isolation, save and reader colour.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill()});
