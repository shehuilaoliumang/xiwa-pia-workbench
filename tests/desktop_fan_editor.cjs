'use strict';
// Real fan Electron shell against an isolated SOURCE service. No EXE is built.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {spawn} = require('node:child_process');
const {_electron: electron} = require('playwright');
const root = path.resolve(__dirname, '..'), fan = path.join(root, '内容编辑器');
const data = path.join(root, '.qa', 'fan-desktop-' + Date.now());
const output = path.join(root, '.qa', 'fan-role-defaults-desktop-20260930');
const base = 'http://127.0.0.1:9043';
const result = {passed:false,errors:[],checks:[],screenshots:[],data_dir:data,scope:'Fan source service and real Electron shell; EXE not built or verified'};
let child, app, page, csrf;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100);}throw Error('Timed out: '+label);}
async function json(route,options){const r=await fetch(base+route,options);const value=await r.json();assert(r.ok,JSON.stringify(value));return value;}
async function resize(width,height,zoom){await app.evaluate(({BrowserWindow},{width,height,zoom})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(width,height);w.webContents.setZoomFactor(zoom);},{width,height,zoom});await delay(300);}
async function fit(label){
  const sample=await page.evaluate(()=>{
    const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    return{width:innerWidth,height:innerHeight,scroll_width:document.documentElement.scrollWidth,save:rect('btnSave'),quit:rect('btnQuit'),editor:rect('editorPanel')};
  });
  assert(sample.scroll_width<=sample.width+2,label+' horizontal overflow: '+JSON.stringify(sample));
  for(const control of [sample.save,sample.quit])assert(control.width>0&&control.x>=0&&control.y>=0&&control.right<=sample.width+2&&control.bottom<=sample.height+2,label+' visible top actions: '+JSON.stringify(sample));
  result.checks.push(label+': actual renderer has no horizontal overflow and save/quit are visible');
}
async function shot(name){
  // Prime the hidden window's compositor, then keep the latest native pixels.
  let encoded;
  for(let i=0;i<3;i++){encoded=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await delay(180);}
  const target=path.join(output,name);await fs.writeFile(target,Buffer.from(encoded,'base64'));result.screenshots.push(target);
}
(async()=>{
  await fs.mkdir(output,{recursive:true});let occupied=false;try{await fetch(base+'/api/health');occupied=true;}catch{}assert(!occupied,'Never reuse an occupied QA service');
  child=spawn(path.join(root,'runtime','python.exe'),['-X','utf8',path.join(fan,'fan_entry.py'),'--no-browser','--port','9043','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{const health=await json('/api/health');return health.app==='content-editor'&&path.resolve(health.data_dir)===data&&health.version==='0.2.1';}catch{return false;}},'fan service identity');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  app=await electron.launch({executablePath:path.join(root,'desktop','runtime','electron.exe'),args:[path.join(fan,'desktop','main.cjs'),'--url='+base+'/','--data-dir='+data,'--no-show'],cwd:fan,env,timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>result.errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.waitForSelector('#btnNew');assert.equal(page.url(),base+'/');
  const verified=await json('/api/health');
  assert.equal(path.resolve(verified.data_dir),data);result.checks.push('Real Electron opens the exact isolated service with the correct health data directory');
  csrf=await page.locator('meta[name="csrf"]').getAttribute('content');
  const workspace=await json('/api/workspaces/new',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({title:'桌面兼容验收',role_colors:{甲:'#aa2244'},blocks:[{id:'fan-desk-a',kind:'text',role:'甲',text:'测试台词：角色默认色保留。',color:'#aa2244'},{id:'fan-desk-b',kind:'text',role:'甲',text:'本句可保留特殊配色。',color:'#224488'}]})});
  result.workspace_id=workspace.workspace.id;
  await page.reload();await page.waitForSelector('#wsList .ws-card');await page.locator('#wsList .ws-card [data-act="open"]').first().click();await page.locator('#editorPanel').waitFor({state:'visible'});
  await page.locator('#roleDefaults').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#roleDefaultList [data-role-default="甲"]').inputValue(),'#aa2244');
  const savedBefore=await json('/api/workspaces/'+workspace.workspace.id);
  await page.locator('#newRoleName').fill('乙');
  await page.locator('#newRoleColor').evaluate(node=>{node.value='#224466';node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.locator('#btnAddRoleDefault').click();
  assert.equal(await page.locator('#roleDefaultList [data-role-default="乙"]').inputValue(),'#224466');
  const unsaved=await json('/api/workspaces/'+workspace.workspace.id);
  assert.deepEqual(unsaved.script.role_colors,savedBefore.script.role_colors);
  assert.deepEqual(unsaved.script.blocks,savedBefore.script.blocks);
  result.checks.push('Visible role-default panel adds a preset in the current draft without saving or recoloring existing sentences');
  await page.locator('#btnSave').click();
  await until(async()=>{const fresh=await json('/api/workspaces/'+workspace.workspace.id);return fresh.script.role_colors['乙']==='#224466';},'role preset saved by the real Electron interface');
  const savedAfter=await json('/api/workspaces/'+workspace.workspace.id);
  assert.deepEqual(savedAfter.script.blocks,savedBefore.script.blocks);
  await page.locator('#btnSave').waitFor({state:'visible'});
  await until(async()=>await page.locator('#btnSave').isEnabled(),'save lock released');
  result.checks.push('Real Electron save persists the new role default and preserves all original sentence colors and runs');
  await page.addStyleTag({content:'input,textarea{caret-color:transparent!important}'});
  await resize(1280,840,1);await fit('1280x840 normal');await shot('fan-desktop-normal.png');
  await resize(1280,840,1.25);await fit('1280x840 at125%');await shot('fan-desktop-125.png');
  await resize(960,640,1.25);await fit('960x640 at125%');await shot('fan-desktop-small-125.png');
  const closing=app.waitForEvent('close',{timeout:12000});await page.locator('#btnQuit').click();await closing;
  await until(async()=>child.exitCode!==null,'owned source service stops');
  result.checks.push('Safe-exit button stops the owned source service and its real Electron health monitor closes the window');
  assert.deepEqual(result.errors,[]);result.passed=true;console.log('Fan desktop source passed ('+result.checks.length+' groups).');
})().catch(error=>{result.failure=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{
  if(app)try{await app.close();}catch{}
  if(child&&child.exitCode===null){try{await json('/api/shutdown',{method:'POST',headers:{'X-CSRF-Token':csrf||''}});await until(async()=>child.exitCode!==null,'cleanup owned service');}catch{child.kill();}}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
});
