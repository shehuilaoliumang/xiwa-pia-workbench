const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),python=path.join(root,'runtime','python.exe');
const data=path.join(root,'.qa','import-editor-'+Date.now()),base='http://127.0.0.1:8896';
let browser,child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('Timed out: '+label)}
const stop=()=>execFileSync(python,['-X','utf8','tools/stop.py','--data-dir',data],{cwd:root,windowsHide:true});
(async()=>{
  child=spawn(python,['-X','utf8','run.py','--no-browser','--port','8896','--data-dir',data],{cwd:root,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await(await fetch(base+'/api/health')).json()).data_dir===data}catch{return false}},'isolated server');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const lib=async()=> (await context.request.get(base+'/api/library')).json();
  const initial=await lib(),page=await context.newPage();await page.goto(base+'/manage');
  await page.waitForFunction(()=>typeof window.wbEditor?.getDraft==='function');
  const editor=page.locator('#script-dialog'),importer=page.locator('#import-editor-dialog');
  const draft=()=>page.evaluate(()=>window.wbEditor.getDraft());
  const openImport=async()=>{await page.locator('#body-editor-details').evaluate(element=>{element.open=true});await page.locator('#open-import-editor').click();await importer.waitFor()};
  const analyze=async()=>{await importer.locator('#import-analyze').click();await importer.locator('#import-result').waitFor();await until(async()=>!await importer.locator('#import-fill-editor').isDisabled(),'import candidate ready')};
  const paste=async text=>{await importer.locator('#import-text').fill(text);await analyze()};
  const cancel=async()=>{await importer.locator('[data-import-close]').last().click();await importer.waitFor({state:'hidden'})};
  const fill=async()=>{await importer.locator('#import-fill-editor').click();await importer.waitFor({state:'hidden'})};
  const save=async()=>{await editor.locator('button[type="submit"]').click();await editor.waitFor({state:'hidden'})};
  const openScript=async id=>{await page.locator(`[data-edit-script="${id}"]`).click();await editor.waitFor()};
  const file=async(name,buffer)=>{
    await importer.locator('[data-import-source="file"]').click();
    await importer.locator('#import-file').setInputFiles({name,mimeType:name.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain',buffer});
  };
  const pasted='剧名：导入验收新条目\n作者：测试作者\n\n \t \n　\n旁白：窗外下起了雨。\n小甲：你好。\n这是没有角色前缀的续行。\n小北：再见。\n';
  const pastedBody='剧名：导入验收新条目\n作者：测试作者\n旁白：窗外下起了雨。\n小甲：你好。\n这是没有角色前缀的续行。\n小北：再见。\n';
  const assertSkippedBlanks=async(expectedBody,blocks,skipped)=>{
    const paragraphs=await importer.locator('.import-paragraph-text').allTextContents();
    assert.equal(paragraphs.join(''),expectedBody,'nonempty lines preserve every character and line ending');
    assert.equal(paragraphs.length,blocks,'blank lines do not count as imported paragraphs');
    assert(paragraphs.every(text=>text.trim().length>0),'no whitespace-only imported blocks');
    assert((await importer.locator('#import-preview-meta').textContent()).startsWith(`${blocks} 个段落`));
    assert((await importer.locator('#import-warnings').textContent()).includes(`已跳过 ${skipped} 个纯空行`));
  };
  await page.locator('#new-script').click();const blank=await draft();
  await openImport();await paste(pasted);
  assert.equal(await importer.locator('#import-source-text').textContent(),pasted,'original pasted text remains exact');
  await assertSkippedBlanks(pastedBody,6,3);
  assert((await importer.locator('#import-role-list').textContent()).includes('小甲'));
  await cancel();assert.deepEqual(await draft(),blank,'canceling the preview leaves the current draft unchanged');
  assert.equal((await lib()).scripts.length,initial.scripts.length,'recognition and cancellation do not create a script');

  await openImport();await paste(pasted);assert(await importer.locator('#import-mode-append').isChecked());await fill();
  let currentDraft=await draft();assert.equal(currentDraft.blocks.map(block=>block.text||'').join(''),pastedBody);assert.equal(currentDraft.blocks.length,6);
  assert.equal(await page.locator('#edit-title').inputValue(),'导入验收新条目');assert.equal(await page.locator('#edit-author').inputValue(),'测试作者');
  assert.equal((await lib()).scripts.length,initial.scripts.length,'filling the editor is still only a draft');
  const roles=()=>page.locator('#script-role-options option').evaluateAll(items=>items.map(item=>item.value));
  assert((await roles()).includes('小甲'));assert((await roles()).includes('小北'));
  const roleInput=page.locator('[data-block-role]').first();assert.equal(await roleInput.getAttribute('list'),'script-role-options');
  await roleInput.fill('新角色');assert((await roles()).includes('新角色'),'newly typed roles are reusable immediately');
  await page.locator('#add-block').click();await page.locator('[data-block-role]').last().fill('小甲');
  await save();
  let created=(await lib()).scripts.find(item=>item.title==='导入验收新条目');assert(created);
  assert.equal(created.blocks.map(block=>block.text||'').join(''),pastedBody,'role edits do not strip or rewrite nonempty dialogue text');
  const stableBlocks=created.blocks;

  // TXT content is displayed as text, and append retains every existing block and identifier.
  await openScript(created.id);await openImport();
  const txt='\n \t \n　\n阿甲：TXT 保真内容。\n<script>window.__importXss=true</script>\n小北：保留 <b>尖括号</b>。\n';
  const txtBody='阿甲：TXT 保真内容。\n<script>window.__importXss=true</script>\n小北：保留 <b>尖括号</b>。\n';
  await file('导入验收.txt',Buffer.from(txt,'utf8'));await analyze();
  assert.equal(await importer.locator('#import-source-text').textContent(),txt);
  await assertSkippedBlanks(txtBody,3,3);
  assert.equal(await importer.locator('#import-preview-blocks script').count(),0);assert.equal(await page.evaluate(()=>window.__importXss),undefined);
  await fill();currentDraft=await draft();assert.deepEqual(currentDraft.blocks.slice(0,stableBlocks.length),stableBlocks);
  assert.equal(currentDraft.blocks.slice(stableBlocks.length).map(block=>block.text||'').join(''),txtBody);
  assert.equal(currentDraft.blocks.length,stableBlocks.length+3);
  assert(stableBlocks.some(block=>block.kind==='text'&&!block.text.trim()),'existing manually added blank block is deliberately retained');
  assert.equal(new Set(currentDraft.blocks.map(block=>block.id)).size,currentDraft.blocks.length,'imported blocks get unique identifiers');
  assert.deepEqual((await lib()).scripts.find(item=>item.id===created.id).blocks,stableBlocks,'append is not saved before the normal save action');
  await save();created=(await lib()).scripts.find(item=>item.id===created.id);
  assert.deepEqual(created.blocks.slice(0,stableBlocks.length),stableBlocks);

  // A minimal DOCX includes paragraphs, a soft line break, a tab, and table-cell text.
  const docx=path.join(data,'fixture.docx');
  const documentXml='<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>剧名：导入文档</w:t></w:r></w:p><w:p><w:r><w:t>作者：文档作者</w:t></w:r></w:p><w:p/><w:p><w:r><w:t xml:space="preserve"> </w:t><w:tab/><w:t xml:space="preserve"> </w:t></w:r></w:p><w:p><w:r><w:t>　</w:t></w:r></w:p><w:p><w:r><w:t>阿甲：第一句</w:t><w:tab/><w:t>保留制表。</w:t><w:br/><w:t>这是同段换行。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>小北：表格里的台词。</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  execFileSync(python,['-X','utf8','-c',"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('[Content_Types].xml','<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>')\n z.writestr('word/document.xml',sys.stdin.buffer.read())",docx],{cwd:root,windowsHide:true,input:documentXml});
  const illustrated=initial.scripts.find(item=>item.blocks.some(block=>block.kind==='image'));assert(illustrated);
  await openScript(illustrated.id);await page.locator('#edit-author').fill('编辑者保留');const beforeReplace=await draft();
  await openImport();await importer.locator('[data-import-source="file"]').click();await importer.locator('#import-file').setInputFiles(docx);await analyze();
  const docxText='剧名：导入文档\n作者：文档作者\n\n \t \n　\n阿甲：第一句\t保留制表。\n这是同段换行。\n小北：表格里的台词。';
  const docxBody='剧名：导入文档\n作者：文档作者\n阿甲：第一句\t保留制表。\n这是同段换行。\n小北：表格里的台词。';
  assert.equal(await importer.locator('#import-source-text').textContent(),docxText);
  await assertSkippedBlanks(docxBody,5,3);
  await importer.locator('#import-mode-replace').check();await fill();currentDraft=await draft();
  assert.equal(currentDraft.blocks.filter(block=>block.kind!=='image').map(block=>block.text||'').join(''),docxBody);
  assert.equal(currentDraft.blocks.filter(block=>block.kind!=='image').length,5);
  const oldImages=beforeReplace.blocks.filter(block=>block.kind==='image');assert.deepEqual(currentDraft.blocks.filter(block=>block.kind==='image'),oldImages,'replacement retains all original image ids and source fields');
  assert.deepEqual(currentDraft.blocks.slice(-oldImages.length),oldImages,'preserved illustrations follow replacement text');
  assert.equal(await page.locator('#edit-title').inputValue(),illustrated.title);assert.equal(await page.locator('#edit-author').inputValue(),'编辑者保留');
  assert.deepEqual((await lib()).scripts.find(item=>item.id===illustrated.id).blocks,illustrated.blocks);
  await save();const replaced=(await lib()).scripts.find(item=>item.id===illustrated.id);
  assert.deepEqual(replaced.blocks.filter(block=>block.kind==='image'),oldImages);assert.deepEqual(replaced.source_pages,illustrated.source_pages);

  // Unsupported and corrupt files keep the editable draft intact.
  await openScript(replaced.id);const beforeErrors=await draft();await openImport();
  for(const [name,buffer] of [['错误.pdf',Buffer.from('not a supported file')],['损坏.docx',Buffer.from('not a zip file')],['空白.txt',Buffer.from(' \n\t　')]]){
    await file(name,buffer);await importer.locator('#import-analyze').click();
    await until(async()=>!!(await importer.locator('#import-error').textContent()).trim(),'file error '+name);
    assert(await importer.locator('#import-fill-editor').isDisabled());assert.deepEqual(await draft(),beforeErrors);
  }
  await cancel();assert.deepEqual(await draft(),beforeErrors);

  // Canceling an in-flight recognition cannot write into the editor later.
  let release,started=false;const gate=new Promise(resolve=>{release=resolve});
  await page.route('**/api/import-preview',async route=>{started=true;await gate;try{await route.continue()}catch{}});
  await openImport();await importer.locator('#import-text').fill('旁白：取消中的识别。');await importer.locator('#import-analyze').click();
  await until(()=>started,'pending import request');await cancel();release();await delay(250);await page.unroute('**/api/import-preview');
  assert.deepEqual(await draft(),beforeErrors,'a canceled request cannot update the draft');
  await openImport();await paste('旁白：手机预览。\n阿甲：继续核对。');await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(await importer.evaluate(element=>element.scrollWidth<=element.clientWidth),'import dialog fits mobile width');
  await fs.mkdir(path.join(root,'.qa','browser'),{recursive:true});await importer.screenshot({path:path.join(root,'.qa','browser','import-editor-mobile.png')});
  await cancel();assert.deepEqual(await draft(),beforeErrors);assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'.qa','browser','import-editor-result.json'),JSON.stringify({passed:true,browserErrors:errors,blankLineChecks:{paste:{skipped:3,blocks:6},txt:{skipped:3,blocks:3},docx:{skipped:3,blocks:5}},checks:[
    'paste recognition and exact source text','paste TXT DOCX skip empty whitespace tab and full-width blank lines','original source retained while only nonempty lines become blocks','existing manually added blank blocks are not cleaned','preview cancellation and draft-only fill','title and author fill only empty fields',
    'role suggestions and unrestricted new roles','TXT plain-text safety and append source preservation',
    'DOCX paragraphs, tabs, soft line breaks and table text','replacement retains original illustrations and source ids',
    'normal save is required for persistence','unsupported and corrupt files leave the draft intact','canceled in-flight request isolation','mobile dialog bounds'
  ]},null,2));
  console.log('Import editor acceptance passed: preview isolation, full source and nonempty-line fidelity, blank-line skipping across paste/TXT/DOCX, existing-block preservation, role reuse, preserved illustrations, file errors and mobile fit.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();try{stop()}catch{}if(child&&child.exitCode===null)child.kill()});
