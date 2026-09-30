(() => {
  'use strict';
  const editor=window.piaEditor,dialog=document.querySelector('#script-dialog');
  if(!editor||!dialog)return;
  const $=selector=>dialog.querySelector(selector),clone=value=>JSON.parse(JSON.stringify(value));
  // Exact, stable comparison is also the draft's saved-version fingerprint.
  const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  const text=(tag,className,value)=>{const node=document.createElement(tag);node.className=className;node.textContent=value;return node;};
  const tools=document.createElement('section');tools.className='editor-tools';
  tools.innerHTML='<div class="editor-tools-row"><div class="button-row"><button id="editor-undo" type="button" class="button secondary small" disabled>↶ 撤销</button><button id="editor-redo" type="button" class="button secondary small" disabled>↷ 重做</button></div><p id="editor-draft-status" role="status" aria-live="polite">草稿保护准备中…</p></div><div id="editor-recovery" class="editor-recovery" hidden><p id="editor-recovery-message"></p><div class="button-row"><button id="editor-recover" type="button" class="button primary small">恢复草稿</button><button id="editor-discard" type="button" class="button secondary small">丢弃这份草稿</button></div></div><p class="help">自动草稿只保存在本机当前浏览器或桌面工作台，点击“保存剧本”才正式入库。撤销 / 重做：Ctrl+Z / Ctrl+Y，支持 Ctrl+Shift+Z。</p>';
  $('.dialog-heading').after(tools);
  const roles=document.createElement('details');roles.id='editor-role-panel';roles.className='editor-role-panel';
  roles.innerHTML='<summary>角色与默认颜色 <span id="editor-role-count"></span></summary><p class="help">默认颜色用于之后选用该角色的新句，已有句子与原多色文字保持原样。需要修改已有台词时，使用“统一该角色句子”；本句颜色仍可单独设置。</p><div id="editor-role-list"></div><div class="editor-role-add"><label class="field">预设角色<input id="editor-new-role" maxlength="200" placeholder="例如：旁白" autocomplete="off"></label><label class="field">默认色<input id="editor-new-role-color" type="color" value="#4b443a"></label><button id="editor-add-role" type="button" class="button secondary small">添加角色默认色</button></div><p id="editor-role-status" role="status"></p>';
  $('#body-editor-details').querySelector('.body-editor-actions').before(roles);
  const history=document.createElement('details');history.id='editor-history-panel';history.className='editor-history-panel';
  history.innerHTML='<summary>已保存版本与恢复</summary><p class="help">这里记录正式保存之前的版本，自动草稿不会加入该列表。恢复会保留当前已保存版本供再次找回，当前直播画面须重新应用后更新。</p><button id="editor-history-refresh" type="button" class="button secondary small">查看 / 刷新版本</button><p id="editor-history-status" role="status"></p><div id="editor-history-list"></div><div id="editor-history-diff" hidden></div>';
  $('#script-source-note').before(history);
  let prefix=null,current=null,baseline='',storageKey='',pending=null,saved=false,suspend=false,storageProblem='',lastPersistOkay=true,initializing=true;
  const memoryDrafts=new Map();
  let stack=[],position=0,lastGroup='',lastChangeAt=0,persistTimer=null,historyItems=[],selectedHistory=null,historyRequest=0;
  const status=(message,error=false)=>{$('#editor-draft-status').textContent=message;$('#editor-draft-status').classList.toggle('error',error);};
  const dirty=()=>current&&!saved&&stable(current)!==baseline;
  const key=draft=>prefix+(draft.script_id||'new');
  const labelDate=value=>{try{return new Date(value).toLocaleString('zh-CN',{hour12:false});}catch{return value;}};
  function controls(){
    const busy=editor.isBusy(),blocked=busy||Boolean(pending)||initializing;$('#editor-undo').disabled=blocked||position===0;$('#editor-redo').disabled=blocked||position>=stack.length-1;
    for(const node of dialog.querySelectorAll('#editor-role-panel button,#editor-role-panel input,#editor-history-panel button'))node.disabled=blocked;
    for(const node of dialog.querySelectorAll('#editor-recovery button'))node.disabled=busy;
    $('#editor-recover').disabled=busy||Boolean(pending?.invalid);
    for(const node of dialog.querySelectorAll('[id^="edit-"],#body-editor input,#body-editor textarea,#add-block,#add-image-block,#open-import-editor,#script-form button[type="submit"]'))node.disabled=blocked;
    for(const node of dialog.querySelectorAll('[data-remove-block],[data-replace-image],[data-add-image-after]'))node.disabled=blocked;
    for(const node of dialog.querySelectorAll('[data-block-move]')){const i=Number(node.closest('.body-editor-row').dataset.blockIndex),to=i+Number(node.dataset.delta);node.disabled=blocked||to<0||to>=(current?.blocks.length||0);}
    const restore=$('#editor-history-restore');if(restore)restore.disabled=blocked||!selectedHistory;
  }
  function persist(force=false){
    clearTimeout(persistTimer);persistTimer=null;
    if(!prefix||!current||saved||pending||!dialog.open&&force!==true)return;
    try{
      if(dirty()){
        const record={version:1,updated_at:new Date().toISOString(),base:baseline,draft:clone(current)};memoryDrafts.set(storageKey,record);
        localStorage.setItem(storageKey,JSON.stringify(record));lastPersistOkay=true;
        status('草稿已自动保存在本机 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));
      }else{
        const stored=localStorage.getItem(storageKey),known=memoryDrafts.get(storageKey);
        // An unchanged/closed editor must not erase a different tab's draft or
        // an unreadable record that appeared after this editor was opened.
        if(!stored||known&&stored===JSON.stringify(known))localStorage.removeItem(storageKey);
        else{try{if(stable(JSON.parse(stored).draft)===baseline)localStorage.removeItem(storageKey);}catch{}}
        memoryDrafts.delete(storageKey);lastPersistOkay=true;status('与已保存资料一致。');
      }
    }catch{lastPersistOkay=false;status('本机草稿未写入成功：存储空间不足或被禁用。当前窗口暂存可继续编辑，请及时正式保存，避免关闭程序或刷新。',true);}
  }
  function schedulePersist(){clearTimeout(persistTimer);if(dirty()&&!pending)status('正在保护未保存草稿…');persistTimer=setTimeout(persist,380);}
  function readPending(){
    storageProblem='';let raw;
    try{raw=localStorage.getItem(storageKey);}catch{storageProblem='浏览器存储被禁用；草稿只能在当前窗口暂存，请及时正式保存。';}
    const temporary=memoryDrafts.get(storageKey);
    if(temporary&&stable(temporary.draft)!==baseline)return {...clone(temporary),temporary:!lastPersistOkay};
    try{
      if(!raw)return null;
      const item=JSON.parse(raw);
      if(item.version!==1||!item.draft||!Array.isArray(item.draft.blocks)||typeof item.base!=='string'||item.draft.script_id!==current.script_id)throw new Error('Invalid draft');
      if(stable(item.draft)===baseline){localStorage.removeItem(storageKey);return null;}
      return item;
    }catch{return {invalid:true};}
  }
  function recovery(){
    $('#editor-recovery').hidden=!pending;
    if(!pending){controls();return;}
    if(pending.invalid){$('#editor-recovery-message').textContent='发现无法读取的本机草稿，原始记录已保留。请先让维护者检查浏览器存储；如不需要这份草稿，明确丢弃后即可继续编辑。';status('本机草稿损坏或不可读取，等待你选择处理。',true);controls();return;}
    const changed=pending.base!==baseline;
    $('#editor-recovery-message').textContent='发现 '+labelDate(pending.updated_at)+' 的未保存草稿。'+(pending.temporary?'这份内容仅在当前窗口暂存，尚未写入本机存储。':'')+(changed?'当前已保存资料已经变化，恢复会把旧草稿填入编辑器；请先核对，正式保存将覆盖当前资料。':'你可以恢复继续编辑，或丢弃后使用已保存资料。');
    status(changed?'旧草稿与当前资料存在版本差异，等待你选择。':'发现可恢复的本机草稿，等待你选择。',changed);
    controls();
  }
  function renderRoles(){
    if(!current)return;
    const names=[...new Set([...Object.keys(current.role_colors||{}),...current.blocks.filter(b=>b.kind!=='image').map(b=>String(b.role||'').trim()).filter(Boolean)])];
    $('#editor-role-count').textContent='· '+names.length+' 个';
    const rows=names.map(name=>{
      const matches=current.blocks.filter(b=>b.kind!=='image'&&String(b.role||'').trim()===name),configured=Object.hasOwn(current.role_colors||{},name),defaultColor=editor.roleColor(name);
      const exceptions=matches.filter(b=>(b.color||'').toLowerCase()!==defaultColor.toLowerCase()).length;
      const row=document.createElement('div');row.className='editor-role-row';
      const info=text('div','editor-role-info','');info.append(text('strong','',name),text('small','muted',matches.length+' 句 · '+(configured?'已设置默认色':'沿用正文首色')+(exceptions?' · '+exceptions+' 句使用不同颜色':'')));
      const picker=document.createElement('input');picker.type='color';picker.value=defaultColor;picker.setAttribute('aria-label',name+' 默认色');picker.dataset.roleDefault=name;
      const apply=text('button','button secondary small','统一该角色句子');apply.type='button';apply.dataset.roleUnify=name;
      row.append(info,picker,apply);
      if(configured){const remove=text('button','button secondary small','清除默认色');remove.type='button';remove.dataset.roleClear=name;row.append(remove);}
      return row;
    });
    $('#editor-role-list').replaceChildren(...(rows.length?rows:[text('p','help','尚无角色。填写台词角色或在下方预设。')]));controls();
  }
  function changed(event){
    if(!event.draft||suspend)return;
    const next=clone(event.draft),signature=stable(next);
    if(current&&signature===stable(current)){controls();return;}
    const now=Date.now(),group=event.reason==='input'?event.key:'';
    // A run of typing in one field is one undo step. Structural operations and
    // changing fields always make a new step, including completed IME input.
    if(group&&group===lastGroup&&now-lastChangeAt<850&&position>0&&position===stack.length-1)stack[position]=next;
    else{stack=stack.slice(0,position+1);stack.push(next);position++;if(stack.length>81){stack.shift();position--;}}
    lastGroup=group;lastChangeAt=now;current=next;saved=false;
    if(pending){status('你正在编辑新草稿；旧草稿仍待恢复或丢弃。自动保存暂缓。',true);}
    else schedulePersist();
    if(!['input'].includes(event.reason)||event.key?.startsWith('role:')||event.key==='block-field')renderRoles();
    controls();
  }
  function onOpen(draft){
    clearTimeout(persistTimer);current=clone(draft);baseline=stable(current);storageKey=prefix?key(current):'';saved=false;
    stack=[clone(current)];position=0;lastGroup='';lastChangeAt=0;selectedHistory=null;historyItems=[];historyRequest++;
    $('#editor-history-list').replaceChildren();$('#editor-history-diff').hidden=true;$('#editor-history-status').textContent=current.script_id?'点击查看历史保存版本。':'新增剧本正式保存后才会产生历史版本。';
    $('#editor-role-status').textContent='';$('#editor-new-role').value='';pending=prefix?readPending():null;recovery();if(!pending)status(initializing?'正在确认本机资料库，准备草稿保护…':!prefix?'自动草稿暂未启用，请及时正式保存。':storageProblem||'与已保存资料一致。',!initializing&&(!prefix||Boolean(storageProblem)));renderRoles();controls();
  }
  function step(direction){
    if(editor.isBusy()||pending||!dialog.open||document.querySelector('#confirm-dialog').open)return;
    const target=position+direction;if(target<0||target>=stack.length)return;
    const focused=document.activeElement?.closest('.body-editor-row')?.dataset.blockId;
    suspend=true;try{editor.replaceFullDraft(clone(stack[target]),{reason:'undo'});}finally{suspend=false;}
    position=target;current=clone(stack[position]);lastGroup='';lastChangeAt=0;saved=false;schedulePersist();renderRoles();controls();
    if(focused)editor.focusBlock(focused);
  }
  $('#editor-undo').addEventListener('click',()=>step(-1));$('#editor-redo').addEventListener('click',()=>step(1));
  dialog.addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229||event.altKey||!(event.ctrlKey||event.metaKey)||document.querySelector('#confirm-dialog').open||document.querySelector('#import-editor-dialog')?.open)return;
    const key=event.key.toLowerCase();if(key==='z'||key==='y'){event.preventDefault();step(key==='y'||event.shiftKey?1:-1);}
  });
  $('#editor-recover').addEventListener('click',async()=>{
    if(!pending||pending.invalid||editor.isBusy())return;
    const candidate=pending,scriptId=current.script_id;
    if(candidate.base!==baseline&&!await editor.confirm('恢复旧草稿到编辑器？','当前已保存资料已经变化。恢复仅填入编辑器，请检查变化后再保存。',{label:'填入旧草稿'}))return;
    if(!dialog.open||current.script_id!==scriptId||pending!==candidate||editor.isBusy())return;
    pending=null;recovery();editor.replaceFullDraft(candidate.draft,{reason:'recover'});persist();
  });
  $('#editor-discard').addEventListener('click',async()=>{
    if(!pending||editor.isBusy())return;
    const candidate=pending,targetKey=storageKey;
    if(!await editor.confirm('丢弃本机未保存草稿？','丢弃后无法通过草稿恢复找回这份内容。已保存资料与当前编辑器内容保持不变。',{label:'丢弃草稿'}))return;
    if(pending!==candidate||storageKey!==targetKey)return;
    try{localStorage.removeItem(storageKey);memoryDrafts.delete(storageKey);pending=null;recovery();schedulePersist();}catch{status('无法删除草稿，请检查浏览器存储权限。',true);}
  });
  $('#editor-role-list').addEventListener('change',event=>{
    const name=event.target.dataset.roleDefault;if(name===undefined)return;
    try{editor.setRoleColor(name,event.target.value);$('#editor-role-status').textContent='已设置 '+name+' 的草稿默认色；已有台词可保持单句颜色。';}catch(error){$('#editor-role-status').textContent=error.message;}
  });
  $('#editor-add-role').addEventListener('click',()=>{
    try{editor.setRoleColor($('#editor-new-role').value,$('#editor-new-role-color').value);$('#editor-new-role').value='';$('#editor-role-status').textContent='角色已加入草稿，可从台词角色选项中选用。';}catch(error){$('#editor-role-status').textContent=error.message;}
  });
  $('#editor-role-list').addEventListener('click',async event=>{
    const unify=event.target.closest('[data-role-unify]'),clear=event.target.closest('[data-role-clear]');
    try{
      if(clear){editor.removeRoleColor(clear.dataset.roleClear);return;}
      if(!unify||editor.isBusy())return;
      const name=unify.dataset.roleUnify,scriptId=current.script_id,count=current.blocks.filter(b=>b.kind!=='image'&&String(b.role||'').trim()===name).length;
      if(!count){$('#editor-role-status').textContent='此角色尚无台词，新增句子选用后会继承默认色。';return;}
      if(!await editor.confirm('统一 '+name+' 的 '+count+' 句台词颜色？','将按默认色更新本角色所有句子，包括单句特殊色和原有多色片段。仅作用于草稿，可撤销；保存后才正式生效。',{label:'统一这 '+count+' 句'}))return;
      if(!dialog.open||current.script_id!==scriptId||editor.isBusy())return;
      editor.unifyRoleColor(name);$('#editor-role-status').textContent='已统一 '+count+' 句草稿颜色，可使用撤销恢复。';
    }catch(error){$('#editor-role-status').textContent=error.message;}
  });
  function diffVersion(item){
    selectedHistory=item;const panel=$('#editor-history-diff');panel.hidden=false;panel.replaceChildren();
    panel.append(text('h4','','对比：历史版本 → 当前编辑草稿'));
    const old=item.script,now=current,changes=[];
    for(const [field,label] of [['title','名称'],['category_id','分类'],['author','作者'],['synopsis','简介'],['cast_note','配音备注'],['tags','标签'],['notes','备注'],['visible','可见状态'],['role_colors','角色默认色']]){
      if(stable(old[field]??(field==='role_colors'?{}:''))!==stable(now[field]??(field==='role_colors'?{}:''))){const row=text('div','editor-version-field','');row.append(text('strong','',label),text('pre','',typeof old[field]==='object'?JSON.stringify(old[field]||{}):String(old[field]??'')),text('pre','',typeof now[field]==='object'?JSON.stringify(now[field]||{}):String(now[field]??'')));changes.push(row);}
    }
    const oldBlocks=old.blocks||[],newBlocks=now.blocks||[],oldBy=new Map(oldBlocks.map(b=>[b.id,b])),newBy=new Map(newBlocks.map(b=>[b.id,b]));
    const blockSignature=block=>stable(block.kind==='image'?{kind:'image',image_path:block.image_path}:{kind:'text',role:block.role||'',text:block.text||'',color:block.color||'',runs:block.runs||[]});
    const added=newBlocks.filter(b=>!oldBy.has(b.id)),removed=oldBlocks.filter(b=>!newBy.has(b.id)),modified=newBlocks.filter(b=>oldBy.has(b.id)&&blockSignature(b)!==blockSignature(oldBy.get(b.id)));
    panel.append(text('p','help','正文：新增 '+added.length+' 段，移除 '+removed.length+' 段，修改 '+modified.length+' 段。'+(stable(oldBlocks.map(b=>b.id))!==stable(newBlocks.map(b=>b.id))?'段落顺序或数量有变化。':'')));
    function blockText(block){return block.kind==='image'?'[图片] '+block.image_path:(block.role?'【'+block.role+'】 ':'')+(block.text||'')+'\n配色：'+(block.color||'未指定')+(block.runs?.length?'\n原文片段：\n'+block.runs.map(run=>'「'+(run.text||'')+'」 '+(run.color||'未指定')).join('\n'):'');}
    for(const b of [...removed,...added,...modified]){const row=text('div','editor-version-field','');row.append(text('strong','',!newBy.has(b.id)?'移除段落':!oldBy.has(b.id)?'新增段落':'段落修改'),text('pre','',oldBy.has(b.id)?blockText(oldBy.get(b.id)):'（无）'),text('pre','',newBy.has(b.id)?blockText(newBy.get(b.id)):'（无）'));changes.push(row);}
    if(!changes.length)panel.append(text('p','help','资料字段和正文与当前草稿相同。音视频设置会以所选历史版本为准。'));else panel.append(...changes);
    const button=text('button','button secondary','恢复此已保存版本');button.type='button';button.id='editor-history-restore';button.addEventListener('click',restoreVersion);panel.append(button);controls();
  }
  async function restoreVersion(){
    const item=selectedHistory,id=current?.script_id;if(!item||!id||editor.isBusy())return;
    const message='将把正式资料恢复到 '+labelDate(item.created_at)+' 前的版本，包含正文、默认色及音视频设置。当前已保存版本会进入历史；直播画面需重新应用后更新。'+(dirty()?'当前未保存草稿将保留在本机，恢复后可选择继续找回。':'');
    if(!await editor.confirm('恢复这个历史版本？',message,{label:'恢复版本'}))return;
    if(!dialog.open||current?.script_id!==id||selectedHistory!==item||editor.isBusy())return;
    persist();try{await editor.restoreHistory(id,item.id);}catch(error){$('#editor-history-status').textContent='恢复未完成：'+error.message;}
  }
  async function loadHistory(){
    if(!current?.script_id){$('#editor-history-status').textContent='请先正式保存这个新剧本。';return;}
    const id=current.script_id,request=++historyRequest;$('#editor-history-status').textContent='正在读取保存版本…';
    try{
      const response=await editor.history(id);if(request!==historyRequest||current?.script_id!==id||!dialog.open)return;
      historyItems=Array.isArray(response.history)?response.history:[];
      $('#editor-history-list').replaceChildren(...historyItems.map((item,index)=>{const button=text('button','editor-history-entry','版本 '+(historyItems.length-index)+' · '+labelDate(item.created_at)+' · '+(item.script?.title||'未命名'));button.type='button';button.dataset.historyId=item.id;button.addEventListener('click',()=>diffVersion(item));return button;}));
      $('#editor-history-status').textContent=historyItems.length?'找到 '+historyItems.length+' 个旧版本，点击版本查看差异。':'还没有旧版本；下次保存修改后会保留当前版本。';controls();
    }catch(error){if(request===historyRequest)$('#editor-history-status').textContent='读取失败：'+error.message;}
  }
  $('#editor-history-refresh').addEventListener('click',loadHistory);
  history.addEventListener('toggle',()=>{if(history.open&&!historyItems.length)loadHistory();});
  editor.subscribe(event=>{
      if(event.type==='open')onOpen(event.draft);
      else if(event.type==='change')changed(event);
      else if(event.type==='busy')controls();
      else if(event.type==='saved'){saved=true;lastPersistOkay=true;clearTimeout(persistTimer);memoryDrafts.delete(storageKey);try{localStorage.removeItem(storageKey);}catch{status('正式保存成功，但旧本机草稿清理失败。',true);}pending=null;stack=[];position=0;}
      else if(event.type==='close'){persist(true);historyRequest++;if(!saved&&(dirty()||pending)){const toast=document.querySelector('#toast');toast.textContent=pending?'未保存草稿已保留，重新打开后可选择恢复。':lastPersistOkay?'未保存草稿已保存在本机，重新打开同一剧本可继续。':'草稿仅在当前窗口暂存，请重新打开并正式保存，避免刷新或关闭程序。';toast.hidden=false;}}
  });
  if(dialog.open)onOpen(editor.getFullDraft());
  const ready=(async()=>{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),4000);
    try{const response=await fetch('/api/health',{credentials:'same-origin',cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error('health');const health=await response.json();if(typeof health.data_dir!=='string'||!health.data_dir)throw new Error('identity');prefix='xiwa.editor.draft.v1:'+location.origin+':'+encodeURIComponent(health.data_dir)+':';}
    catch{prefix=null;}
    finally{clearTimeout(timeout);initializing=false;}
    if(dialog.open&&current){storageKey=prefix?key(current):'';pending=prefix?readPending():null;recovery();renderRoles();if(!prefix)status('无法确认当前资料库，自动草稿暂未启用。请及时正式保存。',true);else if(!pending)status(storageProblem||'与已保存资料一致。',Boolean(storageProblem));}
    controls();
    return Boolean(prefix);
  })();
  window.addEventListener('pagehide',persist);
  window.addEventListener('beforeunload',event=>{persist();if(editor.isBusy()||dirty()&&!lastPersistOkay){event.preventDefault();event.returnValue='';}});
  window.piaEditorTools={ready,flush:()=>{persist();return {saved,dirty:Boolean(dirty()),storageKey};},undo:()=>step(-1),redo:()=>step(1)};
})();
