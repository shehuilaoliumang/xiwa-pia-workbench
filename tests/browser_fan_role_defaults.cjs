'use strict';

// Source-only acceptance: an owned fan service, unique QA data, and actual Edge.
// The downloaded ZIP is checked by the current ROOT validator, not a fan copy.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const fan = path.join(root, '内容编辑器');
const python = path.join(root, 'runtime', 'python.exe');
const port = 9044;
const base = 'http://127.0.0.1:' + port;
const data = path.join(root, '.qa', 'fan-role-defaults-' + Date.now());
const output = path.join(data, 'evidence');
const result = {passed:false, checks:[], errors:[], screenshots:[], data_dir:data,
  mode:'fan source in Edge; current root ZIP validator; no EXE build or production data'};
let server, browser, context, page, csrf = '', release, serverLog = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = label => result.checks.push(label);
async function until(test, label) {
  for (let i=0; i<180; i++) {if (await test()) return; await delay(80);}
  throw new Error('Timed out: ' + label);
}
async function portAvailable() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
async function ownHealth() {
  const response = await fetch(base + '/api/health');
  if (!response.ok) return false;
  const health = await response.json();
  assert.equal(health.app, 'content-editor');
  assert.equal(health.ok, true);
  assert.equal(health.version, '0.2.1');
  assert.equal(path.resolve(health.data_dir), data);
  return true;
}
const draft = async () => JSON.parse(await page.evaluate(() => JSON.stringify(collect())));
const row = id => page.locator('.block[data-block-id=' + JSON.stringify(id) + ']');
const color = name => page.locator('#roleDefaultList [data-role-default=' + JSON.stringify(name) + ']');
const clear = name => page.locator('#roleDefaultList [data-role-clear=' + JSON.stringify(name) + ']');
async function setColor(input, value) {await input.fill(value); await input.dispatchEvent('input');}
async function addDefault(name, value) {
  await page.locator('#newRoleName').fill(name);
  await setColor(page.locator('#newRoleColor'), value);
  await page.locator('#btnAddRoleDefault').click();
}
async function addSentence(role, text, expectedColor) {
  await page.locator('#btnAddText').click();
  const id = (await draft()).blocks.at(-1).id;
  await row(id).locator('.roleInput').fill(role);
  assert.equal((await draft()).blocks.at(-1).color, expectedColor);
  await row(id).locator('.textInput').fill(text);
  return id;
}
async function stored(id) {
  const response = await context.request.get(base + '/api/workspaces/' + id);
  assert(response.ok(), await response.text());
  return (await response.json()).script;
}
async function save() {
  const response = page.waitForResponse(r => r.request().method()==='PUT' && new URL(r.url()).pathname.startsWith('/api/workspaces/'));
  await page.locator('#btnSave').click();
  const saved = await response;
  assert(saved.ok(), await saved.text());
  await until(async () => !await page.locator('#btnSave').isDisabled(), 'save UI unlock');
}
function fixtureFiles() {
  const code = String.raw`
import copy,hashlib,io,json,sys,wave,zipfile
from pathlib import Path
sys.path.insert(0,str(Path.cwd()))
from PIL import Image
import script_package as package
from storage import encode
folder=Path(sys.argv[1]);folder.mkdir(parents=True,exist_ok=True)
image_io=io.BytesIO();Image.new('RGB',(180,100),(82,133,117)).save(image_io,format='PNG');image=image_io.getvalue()
audio_io=io.BytesIO()
with wave.open(audio_io,'wb')as writer:
 writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(8000);writer.writeframes(b'\0\0'*16000)
audio=audio_io.getvalue()
sha=lambda blob:hashlib.sha256(blob).hexdigest()
image_ref='/media/'+sha(image)+'.png';audio_ref='/media/'+sha(audio)+'.wav'
script={'id':'role-default-script','title':'角色默认色专项','category_id':'role-default-category','author':'验收',
 'role_colors':{'甲':'#bb6633'},'source_pages':[7],'source_category':'测试分组',
 'blocks':[{'id':'role-default-primary','kind':'text','role':'甲','text':'保留原多色台词','color':'#aa2244',
  'runs':[{'text':'保留','color':'#aa2244','bold':True},{'text':'原多色台词','color':'#2288aa'}],
  'source_file':'角色来源.pptx','source_page':7,'original_text':'保留原多色台词'},
  {'id':'role-default-exception','kind':'text','role':'甲','text':'手动特殊色不能被默认色覆盖','color':'#775533'},
  {'id':'role-default-fallback','kind':'text','role':'乙','text':'无预设角色的正文首色','color':'#112233'},
  {'id':'role-default-image','kind':'image','text':'关联时间点插图','image_path':image_ref}],
 'media':{'path':audio_ref,'kind':'audio','name':'角色实验.wav','sha256':sha(audio),'size':len(audio),'duration':2,
 'cues':[{'id':'role-default-cue','at':.5,'label':'文字与插图','block_ids':['role-default-primary','role-default-image']}]}}
script=package._normalize(script)
blobs={image_ref:(image,'image/png'),audio_ref:(audio,'audio/wav')}
def write_package(item,name):
 content=encode(item).encode('utf-8');files={'script.json':{'size':len(content),'sha256':sha(content),'mime':'application/json'}};mapping={}
 for ref,(blob,mime)in blobs.items():
  member='assets/'+ref.rsplit('/',1)[1];mapping[ref]=member;files[member]={'size':len(blob),'sha256':sha(blob),'mime':mime}
 manifest={'format':package.FORMAT,'version':package.VERSION,'created_at':'2026-09-30T00:00:00+00:00','category_name':'测试分组','files':files,'resources':mapping}
 with zipfile.ZipFile(folder/name,'w',zipfile.ZIP_DEFLATED)as archive:
  archive.writestr('script.json',content);archive.writestr('manifest.json',encode(manifest))
  for ref,(blob,mime)in blobs.items():archive.writestr(mapping[ref],blob)
write_package(script,'source.zip')
cap=copy.deepcopy(script);cap['title']='角色默认色上限专项';cap['role_colors']={f'预设-{i:03}':'#334455' for i in range(200)}
write_package(package._normalize(cap),'capacity.zip')
print(json.dumps({'script':script,'resources':{ref:sha(blob)for ref,(blob,mime)in blobs.items()},'validator':str(Path(package.__file__).resolve())},ensure_ascii=False))
`;
  return JSON.parse(execFileSync(python, ['-X','utf8','-c',code,data], {cwd:root, windowsHide:true, encoding:'utf8'}));
}
async function screenshot(width) {
  await page.setViewportSize({width, height:1000});
  await until(async () => await page.locator('#toast').evaluate(node => !node.classList.contains('show') && Number(getComputedStyle(node).opacity)===0), 'toast finishes dismissing before screenshot');
  await page.locator('#newRoleName').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector('#roleDefaultList').scrollTop=0);
  const bounds = await page.evaluate(() => {
    const panel=document.querySelector('#roleDefaults'), rect=panel.getBoundingClientRect();
    const controls=[...panel.querySelectorAll('input,button')].map(node => {const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};});
    return {outer:document.documentElement.scrollWidth,viewport:innerWidth,panelLeft:rect.left,panelRight:rect.right,
      panelScroll:panel.scrollWidth,panelWidth:panel.clientWidth,controls};
  });
  assert(bounds.outer<=width+1, 'outer overflow '+width);
  assert(bounds.panelLeft>=-1 && bounds.panelRight<=width+1, 'panel outside viewport '+width);
  assert(bounds.panelScroll<=bounds.panelWidth+1, 'panel overflow '+width);
  assert(bounds.controls.every(c => c.width>0 && c.left>=bounds.panelLeft-1 && c.right<=bounds.panelRight+1), 'control outside panel '+width);
  assert(await page.locator('#btnAddRoleDefault').isVisible());
  const image=path.join(output,'role-defaults-'+width+'.png');
  await page.screenshot({path:image});
  result.screenshots.push(image);result['bounds_'+width]=bounds;
}
(async () => {
  await fs.mkdir(output,{recursive:true});
  await portAvailable();
  const source=fixtureFiles();
  assert.equal(source.validator,path.join(root,'script_package.py'));
  const env={...process.env};delete env.FAN_EXE;
  server=spawn(python,['-X','utf8',path.join(fan,'fan_entry.py'),'--port',String(port),'--no-browser','--data-dir',data],
    {cwd:fan,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  server.stdout.on('data',value => {serverLog+=value;});server.stderr.on('data',value => {serverLog+=value;});
  await until(async () => {
    if(server.exitCode!==null)throw Error('owned fan source exited: '+serverLog);
    try {return await ownHealth();} catch(error) {if(error.name==='AssertionError')throw error;return false;}
  },'owned isolated fan source');
  const record=JSON.parse(await fs.readFile(path.join(data,'server.json'),'utf8'));
  assert.equal(record.pid,server.pid);assert.equal(record.url,base+'/');
  result.owned_service_pid=server.pid;check('health app/version/workspace and server PID prove the owned source service');
  browser=await chromium.launch({channel:'msedge',headless:true});
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',error => result.errors.push(error.message));
  page.on('dialog',dialog => dialog.accept());
  await page.goto(base+'/');csrf=await page.locator('meta[name="csrf"]').getAttribute('content');
  await page.locator('#filePackage').setInputFiles(path.join(data,'source.zip'));
  await page.locator('#roleDefaults').waitFor();await until(async () => (await draft())?.blocks.length===4,'source package opened');
  const wsid=await page.evaluate(() => currentId);
  const originalBlocks=JSON.parse(JSON.stringify((await draft()).blocks));
  await addDefault('预设无台词','#228866');
  assert.equal((await draft()).role_colors['预设无台词'],'#228866');
  assert.equal(await page.locator('#fan-role-options option[value="预设无台词"]').count(),1);
  assert(!(await draft()).blocks.some(b => b.role==='预设无台词'));
  await addSentence('预设无台词','先设默认色再写台词','#228866');
  check('UI adds a preset without dialogue, exposes a role candidate, and binds the later sentence colour');

  await color('甲').evaluate(node => {node.dataset.testPersistent='same-input';node.focus();});
  await setColor(color('甲'),'#337799');
  assert.equal(await color('甲').getAttribute('data-test-persistent'),'same-input');
  assert.equal(await color('甲').evaluate(node => document.activeElement===node),true,'colour input retains focus');
  assert.deepEqual((await draft()).blocks.slice(0,4),originalBlocks);
  const specialNew=await addSentence('甲','之后新增句子才使用新默认色','#337799');
  await setColor(row(specialNew).locator('.colorInput'),'#663388');
  await setColor(color('甲'),'#44aa88');
  assert.equal((await draft()).blocks.find(b => b.id===specialNew).color,'#663388');
  assert.deepEqual((await draft()).blocks.slice(0,4),originalBlocks);
  check('changing default preserves existing manual exceptions and original runs; colour input retains its node and focus');

  await clear('甲').click();assert(!Object.hasOwn((await draft()).role_colors,'甲'));
  await addSentence('甲','清除预设后使用原正文首色','#aa2244');
  await addSentence('乙','未设置默认色的角色也使用正文首色','#112233');
  await addDefault('甲','#44aa88');
  assert.deepEqual((await draft()).blocks.slice(0,4),originalBlocks);
  check('clear removes only the explicit default; later role selection falls back to its first authored colour');

  for(const [name,value] of [['constructor','#446688'],['__proto__','#229955'],['角色 "<>&\'','#885533']]) {
    await addDefault(name,value);assert.equal((await draft()).role_colors[name],value);
    assert.equal(await color(name).count(),1);await addSentence(name,'安全的特殊角色名',value);
  }
  assert.equal(await page.locator('#roleDefaultList b,#roleDefaultList script').count(),0);
  const paletteBeforeInvalid=(await draft()).role_colors;
  await addDefault('   ','#335577');assert.match(await page.locator('#roleDefaultStatus').innerText(),/角色名/);
  assert.deepEqual((await draft()).role_colors,paletteBeforeInvalid);
  await addDefault('长'.repeat(201),'#335577');assert.match(await page.locator('#roleDefaultStatus').innerText(),/200/);
  assert.deepEqual((await draft()).role_colors,paletteBeforeInvalid);
  await addDefault('名'.repeat(200),'#335577');assert.equal((await draft()).role_colors['名'.repeat(200)],'#335577');
  await clear('名'.repeat(200)).click();
  await page.locator('#newRoleName').fill('');
  check('prototype keys and HTML-like names are safe; blank and 201-character names fail, while the 200-character boundary works');

  const held=new Promise(resolve => {release=resolve;});let intercepted=false;
  await page.route('**/api/workspaces/'+wsid,async route => {
    if(route.request().method()!=='PUT')return route.continue();intercepted=true;await held;return route.continue();
  });
  const saveResponse=page.waitForResponse(r => r.request().method()==='PUT' && r.url().endsWith('/api/workspaces/'+wsid));
  await page.locator('#btnSave').click();await until(() => intercepted,'held save');
  for(const selector of ['#newRoleName','#newRoleColor','#btnAddRoleDefault','#btnSave']) assert(await page.locator(selector).isDisabled(),selector+' must lock');
  assert(await color('甲').isDisabled());assert(await clear('甲').isDisabled());
  release();release=null;const saved=await saveResponse;assert(saved.ok(),await saved.text());
  await until(async () => !await page.locator('#btnSave').isDisabled(),'save unlocked');
  await page.unroute('**/api/workspaces/'+wsid);
  const expectedPalette=(await draft()).role_colors;
  assert.deepEqual((await stored(wsid)).role_colors,expectedPalette);
  await page.reload();await page.getByText('角色默认色专项',{exact:true}).click();
  await until(async () => await page.evaluate(() => currentId)===wsid,'reopen saved workspace');
  assert.deepEqual((await draft()).role_colors,expectedPalette);
  assert.deepEqual((await draft()).blocks.slice(0,4),originalBlocks);
  check('all default controls lock during save, then saved palette and untouched authored blocks survive reopen');

  const downloadEvent=page.waitForEvent('download');await page.locator('#btnExport').click();
  const downloaded=await downloadEvent,zip=path.join(data,'role-default-roundtrip.zip');await downloaded.saveAs(zip);
  const validate=String.raw`import hashlib,json,sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()))
import script_package as p
with open(sys.argv[1],'rb')as stream:
 with p._validated(stream)as pkg:
  print(json.dumps({'script':pkg['script'],'resources':{ref:hashlib.sha256(pkg['paths'][member].read_bytes()).hexdigest()for ref,member in pkg['mapping'].items()},'validator':str(Path(p.__file__).resolve())},ensure_ascii=False))`;
  const exported=JSON.parse(execFileSync(python,['-X','utf8','-c',validate,zip],{cwd:root,windowsHide:true,encoding:'utf8'}));
  assert.equal(exported.validator,path.join(root,'script_package.py'));
  assert.deepEqual(exported.script.role_colors,expectedPalette);
  assert.deepEqual(exported.script.blocks.slice(0,4),originalBlocks);
  assert.deepEqual(exported.script.media,source.script.media);assert.deepEqual(exported.resources,source.resources);
  result.root_validator=exported.validator;result.exported_role_colors=expectedPalette;
  check('actual downloaded ZIP passes the current root validator with palette, original multi-colour runs, source, image/WAV bytes and cue references intact');
  await screenshot(1440);await screenshot(390);
  check('real normal and 390px screenshots show an accessible defaults panel without outer, panel or control horizontal overflow');

  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#filePackage').setInputFiles(path.join(data,'capacity.zip'));
  await until(async () => (await draft())?.title==='角色默认色上限专项','capacity workspace opens');
  const capId=await page.evaluate(() => currentId);
  assert.equal(Object.keys((await draft()).role_colors).length,200);
  await addDefault('第201个预设','#335577');assert.match(await page.locator('#roleDefaultStatus').innerText(),/最多.*200/);
  assert.equal(Object.keys((await draft()).role_colors).length,200);
  await setColor(color('预设-000'),'#550077');assert.equal((await draft()).role_colors['预设-000'],'#550077');
  await save();const capped=await stored(capId);
  const bad=await draft();bad.role_colors['第201个预设']='#335577';
  const denied=await context.request.put(base+'/api/workspaces/'+capId,{data:bad,headers:{'X-CSRF-Token':csrf}});
  assert.equal(denied.status(),400);assert.deepEqual(await stored(capId),capped);
  const tooLong=await draft();tooLong.role_colors={['长'.repeat(201)]:'#335577'};
  const longDenied=await context.request.put(base+'/api/workspaces/'+capId,{data:tooLong,headers:{'X-CSRF-Token':csrf}});
  assert.equal(longDenied.status(),400);assert.deepEqual(await stored(capId),capped);
  check('200 explicit defaults can update and save; the 201st and overlong keys are rejected by UI and server without changing stored data');

  // An asynchronous media response must not replace an unsaved role palette.
  await page.getByText('角色默认色专项',{exact:true}).click();
  await until(async () => await page.evaluate(() => currentId)===wsid,'primary workspace restored');
  await addDefault('解除媒体前的未保存预设','#997722');
  await row('role-default-exception').locator('.textInput').fill('解除媒体之前的正文草稿也必须保留');
  const removed=page.waitForResponse(r => r.request().method()==='DELETE' && r.url().endsWith('/media'));
  await page.locator('#btnMediaRemove').click();const removal=await removed;assert(removal.ok(),await removal.text());
  await until(async () => await page.locator('#mediaEmpty').isVisible(),'media removed');
  assert.equal((await draft()).role_colors['解除媒体前的未保存预设'],'#997722');
  assert.equal((await draft()).blocks.find(b => b.id==='role-default-exception').text,'解除媒体之前的正文草稿也必须保留');
  await save();assert.equal((await stored(wsid)).role_colors['解除媒体前的未保存预设'],'#997722');
  assert.equal((await stored(wsid)).blocks.find(b => b.id==='role-default-exception').text,'解除媒体之前的正文草稿也必须保留');
  check('media removal response preserves both a newly edited unsaved role palette and unsaved dialogue');
  assert.deepEqual(result.errors,[]);result.passed=true;
})().catch(error => {result.error=error.stack;console.error(error);process.exitCode=1;}).finally(async () => {
  if(release)release();
  if(page && !page.isClosed() && !result.passed) {
    result.failed_draft=await draft().catch(() => null);
    await page.screenshot({path:path.join(output,'role-defaults-failure.png'),fullPage:true}).catch(() => {});
  }
  if(server) {
    try {
      if(server.exitCode===null && csrf && await ownHealth()) {
        const pid=JSON.parse(await fs.readFile(path.join(data,'server.json'),'utf8')).pid;
        assert.equal(pid,server.pid,'do not shut down a different process');
        await fetch(base+'/api/shutdown',{method:'POST',headers:{'X-CSRF-Token':csrf}});
      }
      for(let i=0;i<100 && server.exitCode===null;i++)await delay(100);
    } catch(error) {result.shutdown_warning=error.message;}
    if(server.exitCode===null) {server.kill();for(let i=0;i<60 && server.exitCode===null;i++)await delay(100);}
    result.owned_service_exited=server.exitCode!==null;
    try {await portAvailable();result.service_port_closed=true;} catch {result.service_port_closed=false;}
    if(!result.owned_service_exited || !result.service_port_closed) {result.passed=false;process.exitCode=1;}
  }
  if(browser)await browser.close();
  // Evidence is kept under this unique .qa folder; no recursive deletion.
  await fs.writeFile(path.join(output,'fan-process.log'),serverLog);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:result.passed,checks:result.checks,errors:result.errors,result:path.join(output,'result.json'),service_port_closed:result.service_port_closed}));
});
