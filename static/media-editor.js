'use strict';
(() => {
  if (document.body.dataset.page !== 'media-editor') return;
  const $ = selector => document.querySelector(selector);
  const root = $('#media-editor');
  let library = JSON.parse($('#bootstrap').textContent);
  const scriptId = root.dataset.scriptId || decodeURIComponent(location.pathname.split('/')[2] || '');
  let script = (library.scripts || []).find(item => item.id === scriptId);
  let csrf = library.csrf_token || $('meta[name="csrf-token"]').content;
  let cues = [], savedCues = [], activeId = null, dirty = false, busy = false;
  let player = null, detectedDuration = null;
  const timeInputs = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  const str = value => value == null ? '' : String(value);
  const create = (tag, className, value) => { const node=document.createElement(tag); if(className)node.className=className; if(value!==undefined)node.textContent=str(value); return node; };
  const currentCue = () => cues.find(cue => cue.id === activeId) || null;
  const hasMedia = () => Boolean(script?.media?.path);
  const duration = () => Number.isFinite(detectedDuration) && detectedDuration > 0 ? detectedDuration : Number.isFinite(script?.media?.duration) && script.media.duration > 0 ? script.media.duration : null;
  function safeMedia(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
    try { const url=new URL(value,location.origin),path=decodeURIComponent(url.pathname); return url.origin===location.origin&&!url.search&&!url.hash&&!/[\\\u0000-\u001f]/.test(path)&&!path.split('/').some(part=>part==='..'||part==='.')&&(path.startsWith('/media/')||path.startsWith('/static/media/'))?url.pathname:''; } catch (_) { return ''; }
  }
  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '时间待修改';
    const millis=Math.round(value*1000),minutes=Math.floor(millis/60000),seconds=Math.floor(millis/1000)%60;
    return String(minutes).padStart(2,'0')+':'+String(seconds).padStart(2,'0')+'.'+String(millis%1000).padStart(3,'0');
  }
  function parseTime(value) {
    const input=str(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(input)) return Number(input);
    const match=input.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
    return match ? Number(match[1])*60+Number(match[2]) : null;
  }
  function error(message) { $('#media-editor-error').textContent=message||''; $('#media-editor-error').hidden=!message; }
  function setDirty(value=true) { dirty=value; updateControls(); }
  function updateControls() {
    const media=hasMedia(),cue=currentCue();
    root.setAttribute('aria-busy',String(busy));
    $('#media-upload-file').disabled=busy;
    $('#media-upload').disabled=busy||!$('#media-upload-file').files.length;
    $('#media-upload').textContent=media?'替换并关联':'上传并关联';
    $('#media-remove').hidden=!media;$('#media-remove').disabled=busy;
    $('#media-mark-cue').disabled=busy||!media;
    $('#media-save-cues').disabled=busy||!media;
    $('#media-reset-cues').disabled=busy||!dirty;
    $('#media-cue-fields').disabled=busy||!media||!cue;
    $('#media-select-guide').hidden=Boolean(cue);
    $('#media-selected-count').textContent=cue?`已选 ${cue.block_ids.length} 段`:'未选择时间点';
    $('#media-control-link').hidden=!media;
    $('#media-save-state').textContent=busy?'正在处理…':dirty?'有未保存的修改':media?'时间点已保存':'先关联音视频，再标记台词';
    $('#media-save-help').textContent=dirty?'离开页面会丢失这些修改。确认后点击“保存全部时间点”。':'勾选与编辑只保留在当前页面，点击保存后生效。';
    $('#media-cue-count').textContent=`${cues.length} 个`;
    $('#media-cue-list').querySelectorAll('button').forEach(button=>button.disabled=busy);
  }
  async function api(path,body,method='POST',retried=false) {
    const headers={'X-CSRF-Token':csrf},options={method,credentials:'same-origin',cache:'no-store',headers};
    if(body instanceof FormData) options.body=body;
    else if(body!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
    let response;try{response=await fetch(path,options)}catch(_){throw new Error('暂时无法连接本地工作台，请检查服务后重试。')}
    const result=await response.json().catch(()=>({}));
    if(response.status===403&&result.code==='csrf_failed'&&!retried){
      const fresh=await fetch('/api/library',{credentials:'same-origin',cache:'no-store'});const data=await fresh.json();
      if(fresh.ok&&data.csrf_token){csrf=data.csrf_token;return api(path,body,method,true)}
    }
    if(!response.ok)throw new Error(result.error||`操作未完成（${response.status}）`);
    return result;
  }
  async function perform(fn) {
    if(busy)return;busy=true;error('');updateControls();
    try{await fn()}catch(err){error(err.message)}finally{busy=false;updateControls()}
  }
  function confirmAction(title,message,label) {
    return new Promise(resolve=>{
      const dialog=$('#media-confirm-dialog');$('#media-confirm-title').textContent=title;$('#media-confirm-message').textContent=message;$('#media-confirm-yes').textContent=label;
      dialog.returnValue='';dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();
    });
  }
  function acceptScript(result) {
    const next=Array.isArray(result.scripts)?result.scripts.find(item=>item.id===scriptId):result.script||result;
    if(!next||next.id!==scriptId)throw new Error('返回的剧本资料不完整，请刷新页面检查。');
    script=next; savedCues=clone(script.media?.cues||[]);cues=clone(savedCues);timeInputs.clear();
    activeId=cues.some(cue=>cue.id===activeId)?activeId:cues[0]?.id||null;dirty=false;
    $('#media-script-title').textContent=script.title+' · 音视频配本';
    renderCues();renderCueForm();updateControls();
  }
  function updateClock() {
    $('#media-current-time').textContent=formatTime(Number.isFinite(player?.currentTime)?player.currentTime:0);
    $('#media-duration').textContent=duration()==null?'总时长待载入':'总时长 '+formatTime(duration());
  }
  function renderPlayer() {
    if(player){player.pause();player.removeAttribute('src');player.load();player=null;}
    detectedDuration=null;
    const wrap=$('#media-player-wrap');wrap.replaceChildren();
    if(!hasMedia()){
      const empty=create('div','media-player-empty');empty.append(create('span','','♫'),create('strong','','先选择一段音频或视频'),create('p','','文件会保存在本机。拖动播放器进度条，找到要配台词的位置。'));wrap.append(empty);
      $('#media-file-kind').textContent='尚未关联';$('#media-file-name').textContent='支持 MP4、WebM、MP3、WAV、M4A、OGG，单个文件不超过 200 MB。';updateClock();return;
    }
    const path=safeMedia(script.media.path);if(!path){error('媒体路径无效，请重新关联本地文件。');return;}
    player=create(script.media.kind==='video'?'video':'audio');player.id='media-player';player.controls=true;player.preload='metadata';player.setAttribute('playsinline','');player.src=path;player.setAttribute('aria-label','配本音视频播放器');wrap.append(player);
    $('#media-file-kind').textContent=script.media.kind==='video'?'视频':'音频';
    $('#media-file-name').textContent=script.media.name+(Number.isFinite(script.media.size)?` · ${(script.media.size/1048576).toFixed(1)} MB`:'');
    const currentPlayer=player;
    currentPlayer.addEventListener('loadedmetadata',()=>{if(player!==currentPlayer)return;if(Number.isFinite(currentPlayer.duration)&&currentPlayer.duration>0)detectedDuration=currentPlayer.duration;updateClock();validateActiveTime();});
    currentPlayer.addEventListener('durationchange',()=>{if(player!==currentPlayer)return;if(Number.isFinite(currentPlayer.duration)&&currentPlayer.duration>0)detectedDuration=currentPlayer.duration;updateClock();});
    currentPlayer.addEventListener('timeupdate',()=>{if(player===currentPlayer)updateClock()});currentPlayer.addEventListener('seeked',()=>{if(player===currentPlayer)updateClock()});
    currentPlayer.addEventListener('error',()=>{if(player===currentPlayer)error('浏览器暂时无法播放这个文件。可以更换为浏览器支持的编码，已保存的时间点仍会保留。');});updateClock();
  }
  function validateActiveTime() {
    const cue=currentCue();let message='';
    if(cue){
      if(!Number.isFinite(cue.at)||cue.at<0)message='请输入非负秒数，或“分:秒”格式，例如 01:23.500。';
      else if(duration()!=null&&cue.at>duration())message='时间点超过了媒体总时长。';
      else if(cues.some(other=>other.id!==cue.id&&Number.isFinite(other.at)&&Math.abs(other.at-cue.at)<0.0000001))message='这个时间点已存在；请在同一个时间点勾选多段台词。';
    }
    $('#media-time-error').textContent=message;$('#media-time-error').hidden=!message;return !message;
  }
  function renderCues() {
    const list=$('#media-cue-list');list.replaceChildren();$('#media-cue-empty').hidden=Boolean(cues.length);
    [...cues].sort((a,b)=>(Number.isFinite(a.at)?a.at:Infinity)-(Number.isFinite(b.at)?b.at:Infinity)).forEach(cue=>{
      const row=create('li','media-cue-item'+(cue.id===activeId?' is-active':''));row.dataset.cueId=cue.id;
      const select=create('button','media-cue-select');select.type='button';select.dataset.cueSelect=cue.id;select.setAttribute('aria-pressed',String(cue.id===activeId));
      select.append(create('span','media-cue-time',formatTime(cue.at)),create('span','media-cue-title',cue.label||'未命名时间点'),create('span','media-cue-meta',`已选 ${cue.block_ids.length} 段`));
      select.addEventListener('click',()=>{activeId=cue.id;renderCues();renderCueForm();});
      const actions=create('div','media-cue-row-actions'),listen=create('button','','试听'),remove=create('button','','删除');listen.type=remove.type='button';listen.dataset.cueSeek=remove.dataset.cueDelete=cue.id;
      listen.addEventListener('click',()=>seekCue(cue));remove.addEventListener('click',()=>{cues=cues.filter(item=>item.id!==cue.id);timeInputs.delete(cue.id);if(activeId===cue.id)activeId=cues[0]?.id||null;setDirty();renderCues();renderCueForm();});
      actions.append(listen,remove);row.append(select,actions);list.append(row);
    });updateControls();
  }
  async function seekCue(cue) {
    if(!player||!Number.isFinite(cue.at))return;
    error('');try{player.pause();player.currentTime=cue.at;updateClock();await player.play()}catch(_){error('已定位到该时间点。若未开始播放，请点击播放器的播放按钮。')}
  }
  function readable(value) {
    if(!/^#[0-9a-f]{6}$/i.test(value||''))return '#4d4234';
    const rgb=[1,3,5].map(index=>parseInt(value.slice(index,index+2),16));
    if(rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>175)return '#'+rgb.map(channel=>Math.round(channel*.5).toString(16).padStart(2,'0')).join('');return value;
  }
  function appendBlockText(target,block) {
    const runs=Array.isArray(block.runs)?block.runs:[];
    if(runs.length&&runs.map(run=>run.text).join('')===str(block.text))runs.forEach(run=>{const span=create('span','',run.text);span.style.color=readable(run.color||block.color);target.append(span)});
    else{target.textContent=str(block.text);target.style.color=readable(block.color);}
  }
  function blockDisplay(block,index,summary=false) {
    const group=create('div');group.append(create('span','media-block-label',`第 ${index+1} 段 · ${block.kind==='image'?'图片':block.role||'正文'}`));
    if(block.kind==='image'){
      const path=safeMedia(block.image_path);if(path){const img=create('img');img.src=path;img.alt='剧本插图';img.loading='lazy';group.append(img)}else group.append(create('p','muted','这张插图暂时无法显示。'));
    }else{const body=create('div','media-block-text');if(summary)body.dataset.blockSummary='';appendBlockText(body,block);group.append(body)}
    return group;
  }
  function renderChoices() {
    const list=$('#media-block-choices');list.replaceChildren();const cue=currentCue(),query=$('#media-block-search').value.trim().toLocaleLowerCase();
    let count=0;
    (script.blocks||[]).forEach((block,index)=>{
      if(query&&!`${block.role||''} ${block.text||''} ${block.kind==='image'?'图片 插图':''}`.toLocaleLowerCase().includes(query))return;count++;
      const selected=Boolean(cue?.block_ids.includes(block.id)),label=create('label','media-block-choice'+(selected?' is-selected':''));label.dataset.blockId=block.id;
      const input=create('input');input.type='checkbox';input.dataset.cueBlock=block.id;input.checked=selected;input.disabled=!cue;input.setAttribute('aria-label',`选择第${index+1}段${block.kind==='image'?'图片':block.role?'，'+block.role:''}`);
      input.addEventListener('change',()=>{const active=currentCue();if(!active)return;const ids=new Set(active.block_ids);input.checked?ids.add(block.id):ids.delete(block.id);active.block_ids=script.blocks.filter(item=>ids.has(item.id)).map(item=>item.id);label.classList.toggle('is-selected',input.checked);setDirty();renderCues();renderSelection();});
      label.append(input,blockDisplay(block,index,true));list.append(label);
    });if(!count)list.append(create('p','media-no-results','没有找到匹配的段落。'));
  }
  function renderSelection() {
    const preview=$('#media-selected-preview'),cue=currentCue();preview.replaceChildren();
    if(!cue?.block_ids.length){preview.append(create('p','muted',cue?'还未选择台词。勾选上方的文字或图片，保存时每个时间点至少需要一段。':'选择时间点后，勾选对应的文字或图片段落。'));updateControls();return;}
    (script.blocks||[]).forEach((block,index)=>{if(cue.block_ids.includes(block.id)){const item=create('div','media-preview-block');item.dataset.previewBlock=block.id;item.append(blockDisplay(block,index));preview.append(item)}});updateControls();
  }
  function renderCueForm() {
    const cue=currentCue();$('#media-cue-time').value=cue?(timeInputs.get(cue.id)??formatTime(cue.at)):'';$('#media-cue-label').value=cue?.label||'';
    validateActiveTime();renderChoices();renderSelection();updateControls();
  }
  $('#media-upload-file').addEventListener('change',()=>{const file=$('#media-upload-file').files[0];$('#media-upload-status').textContent=file?`已选择：${file.name}。点击“${hasMedia()?'替换并关联':'上传并关联'}”开始上传。`:'请选择本地文件。';updateControls()});
  $('#media-upload').addEventListener('click',async()=>{
    const file=$('#media-upload-file').files[0];if(!file||busy)return;
    if(hasMedia()&&!await confirmAction('替换当前音视频？','替换后，已保存的时间点会清空。'+(dirty?'当前未保存的修改也会丢失。':'')+'请确认新文件后继续。','替换并清空时间点'))return;
    await perform(async()=>{player?.pause();$('#media-upload-status').textContent='正在上传并保存在本机，请稍候…';const form=new FormData();form.append('file',file);try{acceptScript(await api('/api/scripts/'+encodeURIComponent(scriptId)+'/media',form))}catch(err){$('#media-upload-status').textContent='上传未确认成功，请查看提示后重试。当前页面保留了原配本。';throw err}$('#media-upload-file').value='';renderPlayer();$('#media-upload-status').textContent='关联完成。拖动进度条找到位置，再标记对应台词。';});
  });
  $('#media-remove').addEventListener('click',async()=>{
    if(busy||!hasMedia()||!await confirmAction('解除音视频关联？','当前音视频关联与时间点将移除。'+(dirty?'未保存的修改也会丢失。':''),'解除关联'))return;
    await perform(async()=>{player?.pause();acceptScript(await api('/api/scripts/'+encodeURIComponent(scriptId)+'/media',undefined,'DELETE'));renderPlayer();$('#media-upload-status').textContent='已解除关联，可以选择新的本地文件。';});
  });
  $('#media-mark-cue').addEventListener('click',()=>{
    if(!hasMedia()||busy)return;player?.pause();const current=Number.isFinite(player?.currentTime)?player.currentTime:0;
    const at=duration()==null?Math.round(current*1000)/1000:Math.min(duration(),Math.round(current*1000)/1000);
    const existing=cues.find(cue=>Number.isFinite(cue.at)&&Math.abs(cue.at-at)<0.0000001);
    if(existing){activeId=existing.id;$('#media-upload-status').textContent='这个时间点已经存在，可以继续勾选更多台词。';}
    else{const cue={id:'cue-'+crypto.randomUUID(),at,label:'',block_ids:[]};cues.push(cue);activeId=cue.id;setDirty();}
    renderCues();renderCueForm();$('#media-cue-time').focus({preventScroll:true});
  });
  $('#media-cue-time').addEventListener('input',()=>{const cue=currentCue();if(!cue)return;timeInputs.set(cue.id,$('#media-cue-time').value);cue.at=parseTime($('#media-cue-time').value);setDirty();validateActiveTime();renderCues()});
  $('#media-cue-label').addEventListener('input',()=>{const cue=currentCue();if(!cue)return;cue.label=$('#media-cue-label').value;setDirty();renderCues()});
  $('#media-block-search').addEventListener('input',renderChoices);
  $('#media-clear-selection').addEventListener('click',()=>{const cue=currentCue();if(!cue)return;cue.block_ids=[];setDirty();renderChoices();renderCues();renderSelection()});
  $('#media-reset-cues').addEventListener('click',async()=>{if(!dirty||busy||!await confirmAction('放弃未保存的修改？','页面将恢复为最后一次保存的时间点。','放弃修改'))return;cues=clone(savedCues);activeId=cues[0]?.id||null;timeInputs.clear();setDirty(false);error('');renderCues();renderCueForm()});
  $('#media-save-cues').addEventListener('click',()=>perform(async()=>{
    if(!hasMedia())return;
    const seen=new Set();
    for(const cue of cues){
      let message='';
      if(!Number.isFinite(cue.at)||cue.at<0)message='请修正这个时间点的时间格式。';
      else if(duration()!=null&&cue.at>duration())message='这个时间点超过了媒体总时长。';
      else if(seen.has(cue.at))message='两个时间点不能使用相同时间；请在同一个时间点选择多段台词。';
      else if(!cue.block_ids.length)message='每个时间点至少需要选择一段文字或图片；不需要的时间点可以删除。';
      if(message){activeId=cue.id;renderCues();renderCueForm();throw new Error(message)}seen.add(cue.at);
    }
    const payload={cues:clone(cues).sort((a,b)=>a.at-b.at)};if(duration()!=null)payload.duration=duration();
    acceptScript(await api('/api/scripts/'+encodeURIComponent(scriptId)+'/media/cues',payload,'PUT'));
    $('#media-save-state').textContent='全部时间点已保存';$('#media-upload-status').textContent='配本已保存，可前往播控台预览。';
  }));
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  document.addEventListener('click',async event=>{
    const link=event.target.closest('a[href]');if(!dirty||!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||link.target==='_blank')return;
    const url=new URL(link.href,location.href);if(url.origin!==location.origin||url.href===location.href)return;
    event.preventDefault();if(await confirmAction('离开配本编辑页？','当前还有未保存的修改。离开后这些修改会丢失。','放弃修改并离开')){dirty=false;location.assign(url.href)}
  });
  if(!script){error('剧本不存在，请返回选本页。');root.querySelectorAll('button,input').forEach(node=>node.disabled=true);return;}
  acceptScript(script);renderPlayer();$('#media-upload-status').textContent=hasMedia()?'拖动播放器进度条定位，再点击“暂停并标记当前时间”。':'支持 MP4、WebM、MP3、WAV、M4A、OGG，单个文件不超过 200 MB。';
})();
