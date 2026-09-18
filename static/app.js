'use strict';
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  let library = JSON.parse($('#bootstrap').textContent);
  const page = document.body.dataset.page;
  const clone = value => JSON.parse(JSON.stringify(value));
  const visible = value => value !== false && value !== 0;
  const str = value => value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : JSON.stringify(value);
  const esc = value => str(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const color = (value, fallback = '#997342') => /^#[a-f\d]{6}$/i.test(value || '') ? value : fallback;
  const media = value => /^\/(static\/media|media)\/[\w.\/-]+$/.test(value || '') && !value.includes('..') ? value : '';
  // Exact imported strings only: user-written notes and dialogue are untouched.
  const importedSourceNotes = new Set([
  "原目录 p1 备注：小孩子不要选 民国本 一男一女  假面舞会上的相遇，让他对她一面倾心\n待核对/来源说明：SRC-01：p70 疑似错序，未确认，保留 p65–70 原顺序。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p1 备注：旧时代 两女  旧时代两个女孩子的故事\n待核对/来源说明：SRC-02：另有旁白、路人、德音及温惠，原音效署名保留；未提供录音。SRC-06：收录片段从‘此后’开始。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p1 备注：有点难度 两女  一个女人结婚前的幻想\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p2 备注：一男一女 重案组警察因为公事牵扯到孩子，导致孩子意外去世，现在面对妻子\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p2 备注：两女 救赎与被救赎的故事\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p2 备注：一男一女 男主因为打架丢了安排好的工作，原因是看到了女朋友跟着老同学去了宾馆\n待核对/来源说明：SRC-06：正文从‘我？我怎么了？’开始，仅声明 PPT 收录内容。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p3 备注：因为五毛钱吵起来的故事 ， 不分性别，两男两女皆可走\n待核对/来源说明：SRC-03：正文只有‘男’‘女’两角色，原人数备注有歧义，不自动转换为四人本。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p3 备注：台湾腔 一男一女\n待核对/来源说明：SRC-04：目录括注‘欧浩辰，迟早早’，正文为悠悠/张伟扮演欧皓辰/池早早，保留原写法。SRC-06：正文明确标‘节选’。7 张正文插图按原图保留，其中图中文字未另作 OCR 转写，不计入可编辑文字覆盖率。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p4 备注：一男一女 自行理解\n待核对/来源说明：未提供实质剧情简介；‘自行理解’保留为原备注。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p4 备注：两女一个失聪一个失明的两个好朋友惺惺相惜的故事\n待核对/来源说明：SRC-02：p33 另有院长和新闻播报，不假定已经提供对应录音或演员分工。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p4 备注：民国时期的夫妻俩，面对错误的改革制度\n待核对/来源说明：目录未单列配音人数，不自动填充。SRC-06：p22 从【1:26】开始，保留提示，不把它视为演出总时长。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p5 备注：两女 为了求生而谋害他人的两个亡命之徒\n待核对/来源说明：SRC-02：p44–46 还有王叔台词；‘两女’不等于全部发声角色数。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p5 备注：一男一女 心理治疗师和女病人之间发生的故事\n待核对/来源说明：SRC-05：目录简介与选段的治疗者关系有落差；p43‘七年前’与‘去年’并存，未经确认不改写。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。",
  "原目录 p5 备注：古风 两女 鱼玄机相思成疾杀死侍女的故事\n待核对/来源说明：SRC-08：网页使用独立剧本 ID，不复用目录中的遗留外部链接。\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。"
]);
  function displayNotes(value) {
    const original=str(value);
    if(!importedSourceNotes.has(original))return original;
    return original.replace(/^原目录 p\d+ 备注：/,'原备注：')
      .replace(/SRC-\d+：/g,'')
      .replace(/保留 p\d+(?:[–—-]\d+)? 原顺序/g,'保留原顺序')
      .replace(/\bp\d+(?:[–—-]\d+)?\s*/g,'原文');
  }
  const byId = id => library.scripts.find(s => s.id === id);
  const category = id => library.categories.find(c => c.id === id);
  const isSystem = c => c.id === 'uncategorized' || c.system || c.is_system;
  const availableCategories = () => library.categories.filter(c => visible(c.visible) && (!isSystem(c) || library.scripts.some(s => s.category_id === c.id && visible(s.visible))));
  const availableScripts = () => library.scripts.filter(s => visible(s.visible) && visible(category(s.category_id)?.visible));
  let toastTimer;
  function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 3300); }
  async function api(path, body, method = 'POST') {
    const options = {method, credentials:'same-origin', cache:'no-store', headers:{'X-CSRF-Token':library.csrf_token || $('meta[name="csrf-token"]').content}};
    if (body instanceof FormData) options.body = body;
    else if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    let response;
    try { response = await fetch(path, options); } catch (_) { throw new Error('暂时无法连接本地服务，请检查工作台是否仍在运行。'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {const error=new Error(data.error || `操作未完成（${response.status}）`);error.code=data.code;error.status=response.status;throw error;}
    return data;
  }
  function task(handler) { return async event => { try { await handler(event); } catch (err) { toast(err.message, true); } }; }
  function click(id, handler) { const el = $(id); if (el) el.addEventListener('click', task(handler)); }
  function debounce(fn, delay = 230) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
  function confirmAction(title, message, {label = '确认', choices = null} = {}) {
    return new Promise(resolve => {
      const dialog = $('#confirm-dialog'); $('#confirm-title').textContent = title; $('#confirm-message').textContent = message; $('#confirm-yes').textContent = label;
      const extra = $('#confirm-extra'); extra.replaceChildren();
      if (choices) { const field = document.createElement('label'); field.className = 'field'; field.textContent = '将关联剧本转移至'; const select = document.createElement('select'); select.id = 'confirm-choice'; choices.forEach(c => { const option = new Option(c.label, c.value); select.add(option); }); field.append(select); extra.append(field); }
      dialog.returnValue = ''; dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? (choices ? $('#confirm-choice').value : true) : null), {once:true}); dialog.showModal();
    });
  }
  function empty(title, subtitle = '') { return `<div class="empty-state"><strong>${esc(title)}</strong>${esc(subtitle)}</div>`; }
  function optionMarkup(items, selected, labelFn = x => x.title || x.name) { return items.map(item => `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(labelFn(item))}</option>`).join(''); }
  function queueIds() { return library.queue?.script_ids || []; }
  async function saveQueue(ids) { library.queue = await api('/api/queue', {script_ids:ids}, 'PUT'); lastLibraryFingerprint=JSON.stringify([library.categories,library.scripts,library.queue]);renderQueue(); if (page === 'catalog') renderCatalog(); if (page === 'control') schedulePreview(true); }
  async function toggleQueue(id) { const ids = queueIds(); await saveQueue(ids.includes(id) ? ids.filter(x => x !== id) : [...ids,id]); }
  function renderQueue() {
    const root = $('#queue-list'); if (!root) return;
    const ids = queueIds(), scripts = ids.map(byId).filter(Boolean);
    if ($('#queue-count')) $('#queue-count').textContent = scripts.length;
    root.innerHTML = scripts.length ? scripts.map((s,i) => `<li class="queue-item"><span class="queue-number">${String(i+1).padStart(2,'0')}</span><div><strong>${esc(s.title)}</strong><small>${esc(category(s.category_id)?.name || '未分类')}${!visible(s.visible) || !visible(category(s.category_id)?.visible) ? ' · 已隐藏，不进入新展示' : ''}</small></div><div class="queue-actions"><button class="icon-button" data-queue-move="${esc(s.id)}" data-delta="-1" aria-label="上移 ${esc(s.title)}"${i === 0 ? ' disabled' : ''}>↑</button><button class="icon-button" data-queue-move="${esc(s.id)}" data-delta="1" aria-label="下移 ${esc(s.title)}"${i === scripts.length-1 ? ' disabled' : ''}>↓</button><button class="icon-button" data-queue-remove="${esc(s.id)}" aria-label="移除 ${esc(s.title)}">×</button></div></li>`).join('') : '<li class="queue-empty"><span class="empty-mark">＋</span>还没有加入剧本<br>从资料库开始挑选吧</li>';
  }
  document.addEventListener('click', task(async event => {
    const add = event.target.closest('[data-queue-add]'); if (add) { await toggleQueue(add.dataset.queueAdd); toast(queueIds().includes(add.dataset.queueAdd) ? '已加入本场待展示' : '已移出本场待展示'); }
    const remove = event.target.closest('[data-queue-remove]'); if (remove) await saveQueue(queueIds().filter(id => id !== remove.dataset.queueRemove));
    const move = event.target.closest('[data-queue-move]'); if (move) { const ids = [...queueIds()], i = ids.indexOf(move.dataset.queueMove), j = i + Number(move.dataset.delta); if (j >= 0 && j < ids.length) { [ids[i],ids[j]] = [ids[j],ids[i]]; await saveQueue(ids); } }
    const close = event.target.closest('[data-close]'); if (close) $('#'+close.dataset.close).close();
  }));
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (page === 'reader' ? 'catalog' : page)));

  // Catalog: data-driven categories and source-backed metadata.
  let selectedCategory = new URLSearchParams(location.search).get('category') || '';
  function renderFilters() {
    const categories = availableCategories(); if (selectedCategory && !categories.some(c => c.id === selectedCategory)) selectedCategory = '';
    $('#category-filters').innerHTML = `<button class="category-chip${!selectedCategory ? ' active' : ''}" data-category="">分类总览<span class="chip-count">${availableScripts().length}</span></button>` + categories.map(c => `<button class="category-chip${selectedCategory === c.id ? ' active' : ''}" data-category="${esc(c.id)}" title="${esc(c.name)}">${esc(c.name)}<span class="chip-count">${availableScripts().filter(s => s.category_id === c.id).length}</span></button>`).join('');
  }
  function renderCatalog() {
    if (page !== 'catalog') return;
    renderFilters(); const query = $('#catalog-search').value.trim().toLowerCase(), cast = $('#cast-filter').value;
    const overview=!selectedCategory&&!query&&!cast;
    $('#catalog-back-row').hidden=overview;$('#category-filters').hidden=overview;
    $('#catalog-section-title').textContent=overview?'剧本分类':selectedCategory?(category(selectedCategory)?.name||'分类剧本'):'搜索结果';
    $('#catalog-location').textContent=selectedCategory?(category(selectedCategory)?.name||'分类剧本'):'全部分类中的匹配剧本';
    $('#script-grid').classList.toggle('category-overview-grid',overview);
    if(overview){
      const categories=availableCategories();$('#library-count').textContent=availableScripts().length;$('#result-count').textContent=categories.length+' 个分类';$('#category-description').textContent='选择一个分类，查看其中的全部剧本。';
      $('#script-grid').innerHTML=categories.length?categories.map(c=>{const scripts=availableScripts().filter(item=>item.category_id===c.id),image=media(c.background);return `<button type="button" class="category-overview-card" data-open-category="${esc(c.id)}" style="--category-color:${color(c.color)}"><div class="category-overview-art">${image?`<img src="${esc(image)}" alt="" loading="lazy">`:''}<span>${scripts.length} 篇剧本</span></div><div class="category-overview-body"><h3>${esc(c.name)}</h3><p>${esc(c.description||'')}</p><ul>${scripts.length?scripts.slice(0,3).map(script=>`<li>${esc(script.title)}</li>`).join(''):'<li class="muted">暂未收录剧本</li>'}</ul><span class="category-enter">查看全部剧本 →</span></div></button>`;}).join(''):empty('暂无可显示的分类','可在内容管理中新增或恢复分类。');
      return;
    }
    const scripts = availableScripts().filter(s => (!selectedCategory || s.category_id === selectedCategory) && (!cast || str(s.cast_note).includes(cast)) && (!query || [s.title,s.author,s.synopsis,s.cast_note,...(s.tags || []),...(s.blocks || []).map(b => (b.role||'')+' '+(b.text||''))].join(' ').toLowerCase().includes(query)));
    $('#library-count').textContent = availableScripts().length; $('#result-count').textContent = `${scripts.length} 篇剧本`;
    $('#category-description').textContent = selectedCategory ? (category(selectedCategory)?.description || '') : '';
    $('#script-grid').innerHTML = scripts.length ? scripts.map(s => { const c = category(s.category_id), inQueue = queueIds().includes(s.id), image = media(c?.background); return `<article class="script-card" style="--category-color:${color(c?.color)}"><div class="card-image">${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : ''}<span class="card-category" title="${esc(c?.name)}">${esc(c?.name || '未分类')}</span></div><div class="card-body"><h3 class="card-title"><a href="/script/${encodeURIComponent(s.id)}">${esc(s.title)}</a></h3><p class="card-author">${esc(s.author || '作者 / 来源未提供')}</p><p class="card-cast" title="${esc(s.cast_note || '原目录未提供配音配置')}"><span>配音备注</span>${esc(s.cast_note || '原目录未提供')}</p><p class="card-synopsis">${esc(s.synopsis || '原目录未提供简介，可进入阅读查看收录内容。')}</p><div class="tag-row">${(s.tags || []).slice(0,3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></div><div class="card-footer"><a href="/script/${encodeURIComponent(s.id)}">阅读剧本 ↗</a><button class="add-queue${inQueue ? ' selected' : ''}" data-queue-add="${esc(s.id)}">${inQueue ? '✓ 已加入' : '＋ 加入本场'}</button></div></article>`; }).join('') : empty(selectedCategory ? '这个分类暂时没有符合条件的剧本' : '没有找到符合条件的剧本', query || cast ? '试试其他关键词或清除筛选。' : '可以在内容管理中添加剧本。');
  }
  if (page === 'catalog') {
    const openCategory=id=>{selectedCategory=id;renderCatalog();history.replaceState(null,'',id?'/?category='+encodeURIComponent(id):'/');};
    $('#script-grid').addEventListener('click',event=>{const button=event.target.closest('[data-open-category]');if(button)openCategory(button.dataset.openCategory);});
    click('#catalog-back',()=>{$('#catalog-search').value='';$('#cast-filter').value='';openCategory('');});
    $('#catalog-search').addEventListener('input', renderCatalog); $('#cast-filter').addEventListener('change', renderCatalog); $('#category-filters').addEventListener('click', e => { const button=e.target.closest('[data-category]'); if(button){selectedCategory=button.dataset.category;renderCatalog();} }); renderCatalog(); renderQueue(); }

  function appendBlock(container, block, stage = false) {
    if (block.kind === 'image') { const src = media(block.image_path); if (!src) return; const figure = document.createElement('figure'); figure.className = 'image-block'; figure.id = block.id; const img = new Image(); img.src = src; img.alt = '剧本插图'; const caption = document.createElement('figcaption'); caption.textContent = '原稿插图'; figure.append(img,caption); container.append(figure); return; }
    const el = document.createElement('div'); el.id = block.id; el.className = 'text-block'; if (block.role) { el.classList.add('role-line'); const label=document.createElement('span'); label.className='role-label'; label.textContent=block.role; el.append(label); }
    el.style.setProperty('--role-color', color(block.color, '#4b443a'));
    const paragraph=document.createElement('div'); paragraph.className='block-text';
    if (block.runs?.length && block.runs.map(r => r.text).join('') === block.text) block.runs.forEach(run => {const span=document.createElement('span');span.textContent=run.text;span.style.color=color(run.color, color(block.color,'#4b443a'));paragraph.append(span);}); else paragraph.textContent=block.text || '';
    el.append(paragraph);container.append(el);
  }
  if (page === 'reader') {
    const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop()), s = byId(id);
    if (!s) { $('#reader-body').innerHTML = empty('找不到这个剧本','它可能已被移除。请返回资料库。'); $('#reader-title').textContent='剧本不可用'; }
    else {
      document.title = `${s.title} · 喜娃微 PIA`; $('#reader-title').textContent=s.title; $('#reader-author').textContent=s.author || '作者 / 来源未提供'; $('#reader-category').textContent=category(s.category_id)?.name || '未分类'; $('#reader-category').style.setProperty('--category-color',color(category(s.category_id)?.color)); $('#reader-control').href=`/control?script=${encodeURIComponent(id)}`;$('#reader-media').href=`/script/${encodeURIComponent(id)}/media`;$('.breadcrumb a').href='/?category='+encodeURIComponent(s.category_id);$('.breadcrumb a').textContent='← 返回'+(category(s.category_id)?.name||'所属分类');
      const n=$('#reader-notes'); [s.synopsis ? '目录简介：'+s.synopsis : '', s.cast_note ? '原备注：'+s.cast_note : '',displayNotes(s.notes)].filter(Boolean).forEach(text=>{const p=document.createElement('p');p.textContent=text;n.append(p);}); if(!n.childNodes.length)n.textContent='暂无补充备注。';
      const body=$('#reader-body');(s.blocks || []).forEach(block=>appendBlock(body,block));if(!s.blocks?.length)body.innerHTML=empty('正文尚未录入','可在内容管理中补充。');
      const updateQueueButton=()=>{$('#reader-queue').textContent=queueIds().includes(id)?'✓ 已加入本场':'＋ 加入本场';}; updateQueueButton();click('#reader-queue',async()=>{await toggleQueue(id);updateQueueButton();});
      let prefs={};try{prefs=JSON.parse(localStorage.getItem('pia-reader')||'{}');}catch(_){} $('#reader-font').value=prefs.font||20;$('#reader-line').value=prefs.line||1.9;
      const styleReader=()=>{const font=$('#reader-font').value,line=$('#reader-line').value;body.style.setProperty('--reading-font',font+'px');body.style.setProperty('--reading-line',line);$('#reader-font-value').value=font+' px';$('#reader-line-value').value=line;localStorage.setItem('pia-reader',JSON.stringify({font,line}));}; $('#reader-font').addEventListener('input',styleReader);$('#reader-line').addEventListener('input',styleReader);styleReader();
    }
  }

  // Control preview is a separate, non-live snapshot sent to an isolated frame.
  const defaultLayout = {font_size:42,line_height:1.8,padding:72,background_opacity:.4,speed:35,category_columns:0,category_background_opacity:.8,body_mode:'pages',media_caption_mode:'auto',media_caption_layout:'pages',media_side:'left'};
  let draft = {mode:'list',orientation:'portrait',script_id:null,category_ids:[],directory_level:'categories',focus_category_id:null}, lastPreview = null, previewRequest = 0, liveState=library.state, frameReady=false, previewTimer, applying=false, verifiedPayload=null, renderedPreviewId=null;
  const draftLayouts = clone(library.layouts || {portrait:defaultLayout,landscape:defaultLayout});
  function layout() { return {...defaultLayout,...draftLayouts[draft.orientation]}; }
  function draftPayload() { const source=$('#list-source')?.value || 'categories';return {mode:draft.mode,orientation:draft.orientation,script_id:draft.script_id,directory_level:draft.directory_level,focus_category_id:draft.focus_category_id,list_source:source,category_ids:source==='categories'?draft.category_ids:[],...(source==='queue'?{script_ids:queueIds()}:{}),layout:layout()}; }
  const layoutRanges=[['font','font_size'],['line','line_height'],['padding','padding'],['background','background_opacity'],['category-background','category_background_opacity'],['speed','speed']];
  function showLayout() {
    const selected=byId(draft.script_id),hasMedia=Boolean(selected?.media?.path);
    if(draft.mode==='script'&&!hasMedia&&layout().body_mode==='media')draftLayouts[draft.orientation]={...layout(),body_mode:'pages'};
    $('#media-mode-option').disabled=draft.mode!=='script'||!hasMedia;
    $('#control-media-link').href=selected?'/script/'+encodeURIComponent(selected.id)+'/media':'/manage';
    $('#control-media-help').textContent=hasMedia?`${selected.media.name} · ${selected.media.cues?.length||0} 个暂停点`:'关联音视频后可使用时间点暂停模式。';
    const l=layout();
    $('#media-layout-fields').hidden=draft.mode!=='script'||l.body_mode!=='media';
    $('#layout-media-caption').value=l.media_caption_mode||'auto';$('#layout-media-caption-layout').value=l.media_caption_layout||'pages';$('#layout-media-side').value=l.media_side||'left';layoutRanges.forEach(([id,key])=>{$('#layout-'+id).value=l[key];$('#layout-'+id+'-value').value=key.endsWith('_opacity')?Math.round(l[key]*100)+'%':l[key]+(key==='font_size'||key==='padding'?' px':key==='speed'?' px/s':'');});
    $('#layout-category-columns').value=String(l.category_columns);$('#layout-body-mode').value=l.body_mode||'pages';
    sizePreviewCanvas();
  }
  // Scale the existing frame only. Enlarging must never rebuild or apply its snapshot.
  let previewFocusScroll=0;
  function sizePreviewCanvas(){
    if(page!=='control')return;
    const surround=$('.preview-surround'),panel=$('.preview-panel');
    panel.dataset.previewOrientation=draft.orientation;
    const width=surround.clientWidth;
    if(!width)return;
    const focused=document.body.classList.contains('preview-focus');
    const height=draft.orientation==='portrait'?Math.min(width,focused?640:460)*16/9:width*9/16;
    const value=Math.ceil(height+2)+'px';
    if(surround.style.height!==value)surround.style.height=value;
  }
  function setPreviewFocus(enabled){
    const wasFocused=document.body.classList.contains('preview-focus');
    if(enabled===wasFocused)return;
    if(enabled)previewFocusScroll=window.scrollY;
    document.body.classList.toggle('preview-focus',enabled);
    const button=$('#toggle-preview-focus');
    button.setAttribute('aria-pressed',String(enabled));button.textContent=enabled?'恢复工作台':'放大预览';
    sizePreviewCanvas();renderPreviewShortcuts();
    requestAnimationFrame(()=>{
      sizePreviewCanvas();
      if(enabled)$('.preview-heading').scrollIntoView({block:'start',behavior:'instant'});
      else window.scrollTo({top:previewFocusScroll,behavior:'instant'});
    });
  }
  function renderPreviewShortcuts(){
    if(page!=='control')return;
    const info=previewTools?.snapshot_id===lastPreview?.id?previewTools:null;
    const mode=info?.mode||draft.mode,bodyMode=info?.body_mode||layout().body_mode;
    const action=mode==='list'?'方向键选择分类或剧本，Enter 打开':bodyMode==='pages'?'← / ↑ 上一页，→ / ↓ 下一页':bodyMode==='media'?((info?.media_caption_layout||layout().media_caption_layout)!=='scroll'?'← / → 翻台词页，↑ / ↓ 切换台词组':'← / ↑ 上一组台词，→ / ↓ 下一组台词'):'← / ↑ 上一段，→ / ↓ 下一段';
    $('#preview-shortcuts').textContent='点一下预览后，'+action+'。'+(document.body.classList.contains('preview-focus')?'按 Esc 恢复工作台。':'');
  }
  let previewPreferences={placement:'inside',feedback:'confirm'};
  try{const saved=JSON.parse(localStorage.getItem('pia-preview-preferences')||'{}');if(['inside','outside'].includes(saved.placement))previewPreferences.placement=saved.placement;if(['confirm','realtime'].includes(saved.feedback))previewPreferences.feedback=saved.feedback;}catch(_){}
  let previewTools=null, realtimeArmed=false, realtimeBlocked=false, syncErrorMessage='', pendingRealtimeIntent=false;
  let feedbackEpoch=0, syncIntent=0, queuedApply=null, applyPumpRunning=false;
  const previewPositions=new Map();
  const liveChannel=page==='control'&&typeof BroadcastChannel==='function'?new BroadcastChannel('pia-live-display-v1'):null;
  let lastBroadcastRevision=-1, appliedPreviewBinding=null, lastBindingMessage='';
  let livePageInfo=null,pendingPageRequest=null,lastPageStatusKey='',lastPageStatusAt=0;
  function renderLivePages(){
    if(page!=='control')return;
    const paged=liveState?.snapshot?.mode==='script'&&liveState.snapshot.layout?.body_mode==='pages';
    const valid=livePageInfo?.snapshot_id===liveState?.snapshot?.id&&livePageInfo?.revision===liveState?.revision;
    for(const id of ['#live-previous-page','#live-next-page','#live-page-number'])$(id).hidden=!paged;
    $('#live-previous-page').disabled=!paged||!valid||Boolean(pendingPageRequest)||livePageInfo.page_index<=0;
    $('#live-next-page').disabled=!paged||!valid||Boolean(pendingPageRequest)||livePageInfo.page_index>=livePageInfo.page_count-1;
    $('#live-page-number').textContent=valid?`第 ${livePageInfo.page_index+1} / ${livePageInfo.page_count} 页`:'请打开展示窗口';
    if(paged){$('#live-play').disabled=true;$('#live-speed').disabled=true;}
    const key=paged?liveState.snapshot.id+':'+liveState.revision:'';
    if(key&&(key!==lastPageStatusKey||!valid&&performance.now()-lastPageStatusAt>1000)){lastPageStatusKey=key;lastPageStatusAt=performance.now();liveChannel?.postMessage({type:'page-status-request',request_id:crypto.randomUUID(),snapshot_id:liveState.snapshot.id,revision:liveState.revision});}
  }

  function activePreviewBinding(){return Boolean(previewPreferences.feedback==='realtime'&&!realtimeBlocked&&previewReady()&&appliedPreviewBinding&&appliedPreviewBinding.preview_id===lastPreview.id&&appliedPreviewBinding.content_token===verifiedPayload.preview_token&&appliedPreviewBinding.live_snapshot_id===liveState?.snapshot?.id);}
  function syncLiveBinding(){
    if(!frameReady||page!=='control')return;
    const enabled=activePreviewBinding();
    const message={type:'pia-preview-live-binding',enabled,snapshot_id:lastPreview?.id||null,...(enabled?{live_snapshot_id:liveState.snapshot.id,revision:liveState.revision,seek_version:liveState.seek_version,playing:liveState.playing,speed:liveState.speed,media_state:liveState.media_state}:{})};
    const key=JSON.stringify({...message,media_state:undefined});if(key===lastBindingMessage)return;lastBindingMessage=key;
    $('#preview-frame').contentWindow.postMessage(message,location.origin);
  }
  function broadcastLiveState(state){
    if(!state||Number(state.revision)<=lastBroadcastRevision)return;
    lastBroadcastRevision=Number(state.revision);liveChannel?.postMessage({type:'state',state});
  }

  function previewReady() { return Boolean(frameReady && verifiedPayload && lastPreview && renderedPreviewId === lastPreview.id); }
  function canApplyPreview() { return !applying && previewReady(); }
  function hasPreviewContent(){return Boolean(lastPreview&&(lastPreview.mode==='script'?lastPreview.scripts.some(script=>script.blocks?.length||lastPreview.layout?.body_mode==='media'&&script.media?.path):lastPreview.directory_level==='categories'?lastPreview.categories.length:lastPreview.scripts.length));}
  function validPreviewAnchor(anchor){return anchor===null || typeof anchor==='string' && Boolean(lastPreview&&(lastPreview.mode==='script'?lastPreview.scripts.some(script=>(script.blocks||[]).some(block=>block.id===anchor)):lastPreview.directory_level==='categories'?lastPreview.categories.some(item=>'category:'+item.id===anchor):lastPreview.scripts.some(script=>'script:'+script.id===anchor)));}
  function defaultPreviewStatus(){
    if(syncErrorMessage)return syncErrorMessage;
    if(previewPreferences.feedback==='realtime')return realtimeArmed?'实时同步已开启 · 预览操作会更新展示':'已记住实时模式 · 下一次预览操作开始同步';
    return '预览草稿 · 点击应用后更新展示';
  }
  function renderExternalTools(){
    if(page!=='control')return;
    renderPreviewShortcuts();
    const ready=previewReady()&&previewTools?.snapshot_id===lastPreview?.id&&!previewTools?.positioning;
    const mediaPages=previewTools?.body_mode==='media'&&previewTools?.media_caption_layout!=='scroll',pageMode=previewTools?.mode==='script'&&(previewTools?.body_mode==='pages'||mediaPages),currentPage=mediaPages?previewTools?.caption_page_index:previewTools?.page_index,pageCount=mediaPages?previewTools?.caption_page_count:previewTools?.page_count;
    $('#preview-external-tools').hidden=previewPreferences.placement!=='outside';
    $$('[data-preview-external]').forEach(button=>{
      const action=button.dataset.previewExternal;
      button.disabled=!ready||(action==='return-list'?!(previewTools?.can_return??(previewTools?.mode==='script')):['play','previous','next','top'].includes(action)?!previewTools?.has_content:false);
      const paged=previewTools?.mode==='script'&&previewTools?.body_mode==='pages';
      if(action==='play')button.disabled=button.disabled||paged;
      if(action==='previous-page'||action==='next-page'){button.hidden=!pageMode;button.disabled=!ready||!pageMode||!pageCount||(action==='previous-page'?currentPage<=0:currentPage>=pageCount-1);button.textContent=action==='previous-page'?(mediaPages?'← 台词上一页':'← 上一页'):(mediaPages?'台词下一页 →':'下一页 →');}
      const mediaMode=previewTools?.body_mode==='media';
      if(['play','previous','next','top'].includes(action)&&mediaMode){button.textContent=action==='play'?(previewTools.playing?'暂停媒体':'播放 / 读完继续'):action==='previous'?'上一组台词':action==='next'?'下一组台词':'回到开头';}
      if(action==='play'&&!mediaMode)button.textContent=previewTools?.playing?'暂停滚动':previewPreferences.feedback==='realtime'?'开始滚动':'试滚预览';
      if(action==='return-list')button.textContent=previewTools?.mode==='script'?'返回剧本列表':previewTools?.directory_level==='scripts'?'返回分类':'返回目录';
    });
    $('#preview-page-number').hidden=!pageMode;$('#preview-page-number').textContent=pageMode?(pageCount?`${mediaPages?'组内':''}第 ${(currentPage||0)+1} / ${pageCount} 页`:'正在分页…'):'';
  }
  function syncPreviewStatus(message) {
    const enabled=canApplyPreview();$('#apply-display').disabled=!enabled;
    $('#apply-display').textContent=previewPreferences.feedback==='realtime'?'立即同步 →':'应用到展示 →';
    if(message)$('#preview-status').textContent=syncErrorMessage||message;
    $('.preview-panel').classList.toggle('preview-sync-error',Boolean(syncErrorMessage));
    renderExternalTools();syncLiveBinding();
    if(frameReady)$('#preview-frame').contentWindow.postMessage({type:'pia-preview-status',snapshot_id:lastPreview?.id||null,can_apply:enabled,message:$('#preview-status').textContent},location.origin);
  }
  function sendPreviewOptions(){
    if(page!=='control')return;
    $('#preview-toolbar-placement').value=previewPreferences.placement;$('#preview-feedback-mode').value=previewPreferences.feedback;
    const realtime=previewPreferences.feedback==='realtime',outside=previewPreferences.placement==='outside';
    $('.preview-panel').classList.toggle('realtime-feedback',realtime);
    $('#preview-instructions').textContent=(outside?'使用画面下方操作栏，或点击剧本进入阅读。':'点击剧本阅读，鼠标移入画面可直接操作。')+(realtime?'实时模式下，预览操作会同步到展示。':'点击应用后更新展示。');
    $('#layout-feedback-help').textContent=realtime?'横屏与竖屏分别保存；调整排版后会实时同步。':'横屏与竖屏分别保存；调整排版后点击应用更新展示。';
    if(frameReady)$('#preview-frame').contentWindow.postMessage({type:'pia-preview-options',placement:previewPreferences.placement,feedback:previewPreferences.feedback},location.origin);
    renderExternalTools();syncPreviewStatus();
  }
  function sendPreview() {
    if(frameReady && lastPreview && verifiedPayload){$('#preview-frame').contentWindow.postMessage({type:'pia-preview',snapshot:lastPreview},location.origin);syncPreviewStatus('正在呈现预览…');return true;}
    syncPreviewStatus();return false;
  }
  function noteRealtimeIntent(){
    ++syncIntent;
    if(previewPreferences.feedback==='realtime'&&!realtimeBlocked){realtimeArmed=true;pendingRealtimeIntent=true;}
  }
  function schedulePreview(userInitiated=false) {
    if(page!=='control')return;++previewRequest;verifiedPayload=null;renderedPreviewId=null;queuedApply=null;appliedPreviewBinding=null;
    if(userInitiated){if(previewPreferences.feedback==='confirm')syncErrorMessage='';noteRealtimeIntent();}else pendingRealtimeIntent=false;
    syncPreviewStatus('正在更新预览…');clearTimeout(previewTimer);previewTimer=setTimeout(()=>updatePreview(),150);
  }
  async function updatePreview() {
    const request=++previewRequest,payload=draftPayload();verifiedPayload=null;renderedPreviewId=null;syncPreviewStatus('正在更新预览…');
    try {
      const snapshot=await api('/api/preview',payload);if(request!==previewRequest)return;
      lastPreview=snapshot;verifiedPayload={...clone(payload),preview_token:snapshot.content_token};previewTools=null;
      for(const id of previewPositions.keys())if(id!==snapshot.id)previewPositions.delete(id);
      sendPreview();
    }catch(err){if(request!==previewRequest)return;lastPreview=null;verifiedPayload=null;renderedPreviewId=null;queuedApply=null;pendingRealtimeIntent=false;
      if(previewPreferences.feedback==='realtime'){realtimeBlocked=true;realtimeArmed=false;syncErrorMessage='预览未完成，自动同步已停止；请检查设置后重试。';}
      $('#preview-loading').textContent=err.message;$('#preview-loading').hidden=false;syncPreviewStatus('请检查选本范围');}
  }
  function makeApplyJob(anchor,playing,realtime,manual){
    if(!previewReady()||!validPreviewAnchor(anchor))return null;
    const payload={...clone(verifiedPayload),preview_anchor:anchor};
    const position=previewPositions.get(lastPreview.id);if(lastPreview.mode==='script'&&lastPreview.layout?.body_mode==='pages'&&Number.isInteger(position?.page_index)&&position.page_index>=0)payload.preview_page_index=position.page_index;
    if(lastPreview.mode==='script'&&lastPreview.layout?.body_mode==='media'&&position?.media_state)payload.preview_media_state=clone(position.media_state);
    if(realtime){payload.realtime=true;payload.preview_playing=Boolean(playing&&hasPreviewContent());}
    return {payload,snapshot_id:lastPreview.id,epoch:feedbackEpoch,intent:syncIntent,realtime,manual};
  }
  function queueLatestRealtime(){
    if(!pendingRealtimeIntent||!realtimeArmed||realtimeBlocked||previewPreferences.feedback!=='realtime'||!previewReady())return;
    const position=previewPositions.get(lastPreview.id);if(!position)return;
    const job=makeApplyJob(position.anchor,position.playing,true,false);if(!job)return;
    queuedApply=job;pendingRealtimeIntent=false;void drainApplyQueue();
  }
  async function drainApplyQueue(){
    if(applyPumpRunning)return;applyPumpRunning=true;
    try{
      while(queuedApply){
        const job=queuedApply;queuedApply=null;
        if(job.epoch!==feedbackEpoch||job.snapshot_id!==lastPreview?.id||job.payload.preview_token!==verifiedPayload?.preview_token||!previewReady())continue;
        if(job.realtime&&(previewPreferences.feedback!=='realtime'||realtimeBlocked||!realtimeArmed))continue;
        applying=true;syncPreviewStatus(job.realtime?'正在实时同步…':'正在应用到展示…');
        try{
          const state=await api('/api/apply',job.payload);renderLive(state);
          if(job.realtime&&job.epoch===feedbackEpoch&&job.snapshot_id===lastPreview?.id&&job.payload.preview_token===verifiedPayload?.preview_token&&previewReady()){
            appliedPreviewBinding={preview_id:lastPreview.id,content_token:verifiedPayload.preview_token,live_snapshot_id:state.snapshot?.id};syncLiveBinding();
          }
          if(job.epoch===feedbackEpoch&&job.intent===syncIntent&&job.snapshot_id===lastPreview?.id)syncPreviewStatus(job.realtime?'已同步 · 预览操作会实时更新展示':'已应用 · 展示暂停，准备后开始滚动');
          if(job.manual&&!job.realtime)toast(state.notice||'已应用到展示，当前保持暂停。');
        }catch(err){
          if(job.epoch===feedbackEpoch){
            queuedApply=null;pendingRealtimeIntent=false;
            realtimeBlocked=job.realtime;realtimeArmed=false;appliedPreviewBinding=null;
            syncErrorMessage=err.code==='preview_stale'?'资料已变化，请核对新预览后点击'+(previewPreferences.feedback==='realtime'?'立即同步。':'应用。'):'同步未完成：'+err.message+' 请手动重试。';
            if(err.code==='preview_stale')schedulePreview(false);
            syncPreviewStatus(syncErrorMessage);toast(syncErrorMessage,true);
          }
        }finally{applying=false;syncPreviewStatus();}
      }
    }finally{applyPumpRunning=false;applying=false;syncPreviewStatus();}
  }
  async function applyPreview(anchor,playing=false) {
    if(!canApplyPreview()||!validPreviewAnchor(anchor))return;
    const realtime=previewPreferences.feedback==='realtime';syncErrorMessage='';realtimeBlocked=false;
    if(realtime)realtimeArmed=true;++syncIntent;pendingRealtimeIntent=false;
    const job=makeApplyJob(anchor,playing,realtime,true);if(!job)return;queuedApply=job;await drainApplyQueue();
  }
  function renderCategorySelectionState() {
    const categories=availableCategories(), count=categories.filter(item=>draft.category_ids.includes(item.id)).length;
    $('#control-select-all-categories').disabled=!categories.length;
    $('#control-category-count').textContent=categories.length?`已选 ${count} / ${categories.length}`+(count?'':' · 默认全部'):'暂无可见分类';
  }
  function renderControlChoices() {
    const scripts=availableScripts(), cats=availableCategories(); if(draft.script_id&&!scripts.some(s=>s.id===draft.script_id)){draft.script_id=scripts[0]?.id||null;toast('预览所选剧本已不可用，已调整预览；当前展示保持不变。');}
    if(!draft.script_id)draft.script_id=scripts[0]?.id||null;$('#control-script').innerHTML=optionMarkup(scripts,draft.script_id);
    const previousCategoryCount=draft.category_ids.length;draft.category_ids=draft.category_ids.filter(id=>cats.some(c=>c.id===id));if(previousCategoryCount!==draft.category_ids.length)toast('所选分类已变更，预览范围已更新；当前展示保持不变。');
    $('#control-categories').innerHTML=cats.length?cats.map(c=>`<label><input type="checkbox" value="${esc(c.id)}"${draft.category_ids.includes(c.id)?' checked':''}>${esc(c.name)}</label>`).join('')+'<p class="help" style="grid-column:1/-1">未勾选时展示全部可见分类。</p>':'<p class="muted">暂无可显示分类</p>';renderCategorySelectionState();renderQueue();
  }
  function renderLive(state) {
    if(liveState&&state&&Number(state.revision)<Number(liveState.revision))return;liveState=state;const has=Boolean(state?.snapshot), snap=state?.snapshot;
    broadcastLiveState(state);syncLiveBinding();
    const mediaMode=snap?.mode==='script'&&snap.layout?.body_mode==='media';
    $('#live-status').textContent=!has?'尚未上屏':state.playing?(mediaMode?'媒体播放中':'正在滚动'):'已暂停';$('#live-status').className='status-tag'+(state?.playing?' playing':'');
    $('#live-description').textContent=has?`${snap.mode==='script'?(snap.scripts[0]?.title||'正文'):snap.directory_level==='categories'?'分类总览 · '+snap.categories.length+' 类':'剧本目录 · '+snap.scripts.length+' 篇'} · ${snap.orientation==='landscape'?'横屏 16:9':'竖屏 9:16'}${state.notice?' · '+state.notice:''}`:'先应用预览内容，再开始展示。';
    const hasContent=Boolean(has&&(snap.mode==='script'?(snap.scripts[0]?.blocks?.length||snap.layout?.body_mode==='media'&&snap.scripts[0]?.media?.path):snap.directory_level==='categories'?snap.categories.length:snap.scripts.length));['#live-play','#live-pause','#live-top','#live-speed','#live-anchor','#live-seek'].forEach(id=>{$(id).disabled=!hasContent;});$('#live-play').disabled=!hasContent||state.playing;$('#live-pause').disabled=!hasContent||!state.playing;
    renderLivePages();
    $('#live-play').textContent=mediaMode?'▶ 播放 / 读完继续':'▶ 开始滚动';$('#live-top').textContent=mediaMode?'↑ 回到媒体开头':'↑ 返回顶部';
    $('#live-media-help').hidden=!mediaMode;
    $('#live-speed').closest('label').hidden=mediaMode;$('#live-anchor').closest('label').hidden=mediaMode;$('#live-seek').hidden=mediaMode;
    if(document.activeElement!==$('#live-speed'))$('#live-speed').value=state?.speed||35;$('#live-speed-value').value=(state?.speed||35)+' px/s';
    const select=$('#live-anchor'), key=snap?.id||'empty'; if(select.dataset.snapshot!==key){const anchors=snap?(snap.mode==='script'?(snap.scripts[0]?.blocks||[]).map((b,i)=>({id:b.id,title:'段落 '+(i+1)+' · '+(b.kind==='image'?'插图':(b.role?b.role+' · ':'')+str(b.text).slice(0,45))})):snap.directory_level==='categories'?snap.categories.map(c=>({id:'category:'+c.id,title:c.name})):snap.scripts.map(s=>({id:'script:'+s.id,title:s.title}))):[];select.innerHTML=anchors.length?optionMarkup(anchors,state.anchor):'<option value="">尚无内容</option>';select.dataset.snapshot=key;}
  }
  if(page==='control') {
    // Preparation starts at the current catalog, independently of frozen live content.
    draft.category_ids=availableCategories().map(c=>c.id);
    draft.orientation=liveState?.orientation==='landscape'?'landscape':'portrait';
    $('#list-source').value='categories';
    const params=new URLSearchParams(location.search);if(params.get('script')){draft.mode='script';draft.script_id=params.get('script');draft.directory_level='scripts';draft.focus_category_id=byId(draft.script_id)?.category_id||null;draft.category_ids=[];$('#list-source').value='categories';}
    if(params.get('body')==='media'&&byId(draft.script_id)?.media)draftLayouts[draft.orientation]={...layout(),body_mode:'media'};
    $$('[data-orientation]').forEach(button=>button.classList.toggle('active',button.dataset.orientation===draft.orientation));
    $('#preview-size').textContent=draft.orientation==='portrait'?'9:16':'16:9';
    const showMode=()=>{showLayout();$$('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===draft.mode));$('#list-settings').hidden=draft.mode!=='list';$('#script-settings').hidden=draft.mode!=='script';$('#directory-path').textContent=draft.directory_level==='categories'?'分类总览 → 分类内剧本':('分类总览 / '+(category(draft.focus_category_id)?.name||'全部剧本'));};
    const showSource=()=>{const categories=$('#list-source').value==='categories';$('#control-categories').hidden=!categories;$('#control-category-actions').hidden=!categories;$('#control-queue-wrap').hidden=$('#list-source').value!=='queue';renderCategorySelectionState();};
    let returnListSelection={list_source:$('#list-source').value,category_ids:[...draft.category_ids],directory_level:draft.directory_level,focus_category_id:draft.focus_category_id};
    const rememberList=()=>{if(draft.mode==='list')returnListSelection={list_source:$('#list-source').value,category_ids:[...draft.category_ids],directory_level:draft.directory_level,focus_category_id:draft.focus_category_id};};
    $$('[data-mode]').forEach(b=>b.addEventListener('click',()=>{
      if(b.dataset.mode==='script'){
        rememberList();const scoped=availableScripts().filter(script=>script.category_id===draft.focus_category_id);
        if(scoped.length&&!scoped.some(script=>script.id===draft.script_id))draft.script_id=scoped[0].id;
        draft.mode='script';draft.directory_level='scripts';draft.focus_category_id=byId(draft.script_id)?.category_id||null;$('#control-script').value=draft.script_id||'';
      }else{
        // This mode switch is the directory home; preview Back still moves up one level.
        draft.mode='list';draft.directory_level='categories';draft.focus_category_id=null;
      }
      showMode();showSource();schedulePreview(true);
    }));
    $$('[data-orientation]').forEach(b=>b.addEventListener('click',()=>{const keepMedia=draft.mode==='script'&&layout().body_mode==='media'&&byId(draft.script_id)?.media;draft.orientation=b.dataset.orientation;if(keepMedia)draftLayouts[draft.orientation]={...layout(),body_mode:'media'};$$('[data-orientation]').forEach(x=>x.classList.toggle('active',x===b));$('#preview-size').textContent=draft.orientation==='portrait'?'9:16':'16:9';showLayout();schedulePreview(true);}));
    $('#list-source').addEventListener('change',()=>{draft.directory_level='categories';draft.focus_category_id=null;showMode();showSource();schedulePreview(true);});$('#control-script').addEventListener('change',()=>{draft.script_id=$('#control-script').value;draft.directory_level='scripts';draft.focus_category_id=byId(draft.script_id)?.category_id||null;showMode();schedulePreview(true);});$('#control-categories').addEventListener('change',()=>{draft.category_ids=$$('#control-categories input:checked').map(x=>x.value);draft.directory_level='categories';draft.focus_category_id=null;renderCategorySelectionState();showMode();schedulePreview(true);});
    click('#control-select-all-categories',()=>{
      const ids=availableCategories().map(item=>item.id);
      if($('#list-source').value!=='categories'||!ids.length)return;
      const alreadySelected=ids.length===draft.category_ids.length&&ids.every(id=>draft.category_ids.includes(id));
      if(alreadySelected&&draft.directory_level==='categories'&&!draft.focus_category_id)return;
      draft.category_ids=ids;draft.directory_level='categories';draft.focus_category_id=null;
      $$('#control-categories input[type="checkbox"]').forEach(input=>{input.checked=ids.includes(input.value);});
      renderCategorySelectionState();showMode();schedulePreview(true);
    });
    layoutRanges.forEach(([id,key])=>$('#layout-'+id).addEventListener('input',()=>{draftLayouts[draft.orientation]={...layout(),[key]:Number($('#layout-'+id).value)};showLayout();schedulePreview(true);}));
    $('#layout-category-columns').addEventListener('change',()=>{draftLayouts[draft.orientation]={...layout(),category_columns:Number($('#layout-category-columns').value)};showLayout();schedulePreview(true);});
    $('#layout-body-mode').addEventListener('change',()=>{draftLayouts[draft.orientation]={...layout(),body_mode:$('#layout-body-mode').value};showLayout();schedulePreview(true);});
    for(const [id,key] of [['layout-media-caption','media_caption_mode'],['layout-media-caption-layout','media_caption_layout'],['layout-media-side','media_side']])$('#'+id).addEventListener('change',()=>{draftLayouts[draft.orientation]={...layout(),[key]:$('#'+id).value};showLayout();schedulePreview(true);});
    click('#save-layout',async()=>{library.layouts=await api('/api/layouts',{orientation:draft.orientation,layout:layout()},'PATCH');toast('已保存'+(draft.orientation==='portrait'?'竖屏':'横屏')+'设置。');});
    const presetSelect=$('#layout-preset');
    function renderPresets(selected=presetSelect.value){
      presetSelect.innerHTML='<option value="default">系统默认设置</option>'+optionMarkup(library.layout_presets||[],selected,item=>item.name);
      presetSelect.value=[...(library.layout_presets||[]).map(p=>p.id),'default'].includes(selected)?selected:'default';
      const preset=(library.layout_presets||[]).find(item=>item.id===presetSelect.value);
      $('#layout-preset-name').value=preset?.name||'';$('#update-layout-preset').disabled=!preset;$('#delete-layout-preset').disabled=!preset;
      $('#new-layout-preset').disabled=(library.layout_presets||[]).length>=10;
    }
    async function refreshPresets(selected){const data=await api('/api/layout-presets',undefined,'GET');library.layout_presets=data.layout_presets;library.default_layouts=data.default_layouts;renderPresets(selected);}
    presetSelect.addEventListener('change',()=>renderPresets(presetSelect.value));
    click('#load-layout-preset',()=>{
      const layouts=presetSelect.value==='default'?library.default_layouts:(library.layout_presets||[]).find(p=>p.id===presetSelect.value)?.layouts;
      if(!layouts)throw new Error('方案暂不可用，请刷新后重试。');
      for(const orientation of ['portrait','landscape'])draftLayouts[orientation]=clone(layouts[orientation]);
      showLayout();schedulePreview(true);toast('方案已载入预览。');
    });
    function presetData(){const name=$('#layout-preset-name').value.trim();if(!name)throw new Error('请填写方案名称。');return {name,layouts:clone(draftLayouts)};}
    click('#new-layout-preset',async()=>{const preset=await api('/api/layout-presets',presetData());await refreshPresets(preset.id);toast('已保存新的横竖屏方案。');});
    click('#update-layout-preset',async()=>{if(presetSelect.value==='default')return;const data=presetData();if(!await confirmAction('更新这套方案？','用当前横屏和竖屏排版覆盖所选方案，正在展示的内容保持不变。',{label:'更新方案'}))return;const preset=await api('/api/layout-presets/'+encodeURIComponent(presetSelect.value),data,'PATCH');await refreshPresets(preset.id);toast('方案已更新。');});
    click('#delete-layout-preset',async()=>{if(presetSelect.value==='default')return;if(!await confirmAction('删除这套自定义方案？','只删除保存的方案，不改变当前排版或正在展示的内容。',{label:'删除方案'}))return;await api('/api/layout-presets/'+encodeURIComponent(presetSelect.value),{},'DELETE');await refreshPresets('default');toast('方案已删除。');});
    renderPresets();
    $('#preview-toolbar-placement').addEventListener('change',()=>{
      previewPreferences.placement=$('#preview-toolbar-placement').value==='outside'?'outside':'inside';
      try{localStorage.setItem('pia-preview-preferences',JSON.stringify(previewPreferences));}catch(_){}
      sendPreviewOptions();
    });
    $('#preview-feedback-mode').addEventListener('change',()=>{
      previewPreferences.feedback=$('#preview-feedback-mode').value==='realtime'?'realtime':'confirm';
      ++feedbackEpoch;queuedApply=null;pendingRealtimeIntent=false;realtimeArmed=false;realtimeBlocked=false;syncErrorMessage='';appliedPreviewBinding=null;
      try{localStorage.setItem('pia-preview-preferences',JSON.stringify(previewPreferences));}catch(_){}
      if(previewPreferences.feedback==='realtime'){
        if(lastPreview)previewPositions.delete(lastPreview.id);
        noteRealtimeIntent();sendPreviewOptions();syncPreviewStatus('实时同步已开启，正在读取当前预览位置…');
        if(previewReady())$('#preview-frame').contentWindow.postMessage({type:'pia-preview-position-request',snapshot_id:lastPreview.id},location.origin);
      }else{sendPreviewOptions();syncPreviewStatus('已切换为逐步应用 · 后续预览操作不会自动上屏');}
    });
    $('#preview-external-tools').addEventListener('click',event=>{
      const button=event.target.closest('[data-preview-external]');if(!button||button.disabled||!previewReady())return;
      $('#preview-frame').contentWindow.postMessage({type:'pia-preview-command',snapshot_id:lastPreview.id,action:button.dataset.previewExternal},location.origin);
    });
    window.addEventListener('message',task(async event=>{
      if(event.origin!==location.origin || event.source!==$('#preview-frame').contentWindow || !event.data || typeof event.data!=='object')return;
      const data=event.data;
      if(data.type==='pia-preview-exit-focus'){if(lastPreview&&data.snapshot_id===lastPreview.id)setPreviewFocus(false);return;}
      if(data.type==='pia-preview-ready'){frameReady=true;renderedPreviewId=null;sendPreviewOptions();sendPreview();return;}
      if(data.type==='pia-preview-rendered'){
        if(!frameReady||!verifiedPayload||!lastPreview||data.snapshot_id!==lastPreview.id)return;
        renderedPreviewId=data.snapshot_id;$('#preview-loading').hidden=true;syncPreviewStatus(defaultPreviewStatus());queueLatestRealtime();return;
      }
      if(data.type==='pia-preview-position'){
        if(!lastPreview||data.snapshot_id!==lastPreview.id||!validPreviewAnchor(data.anchor)||typeof data.playing!=='boolean'||!['render','interaction'].includes(data.reason))return;
        previewPositions.set(data.snapshot_id,{anchor:data.anchor,playing:data.playing,page_index:Number.isInteger(data.page_index)?data.page_index:null,media_state:data.media_state});
        if(data.reason==='interaction'&&verifiedPayload)noteRealtimeIntent();
        queueLatestRealtime();return;
      }
      if(data.type==='pia-preview-tools'){
        if(!lastPreview||data.snapshot_id!==lastPreview.id||!['list','script'].includes(data.mode))return;
        previewTools={snapshot_id:data.snapshot_id,mode:data.mode,has_content:data.has_content===true,playing:data.playing===true,can_apply:data.can_apply===true,positioning:data.positioning===true,directory_level:data.directory_level,focus_category_id:data.focus_category_id,can_return:data.can_return===true,body_mode:data.body_mode,page_index:data.page_index,page_count:data.page_count,media_caption_layout:data.media_caption_layout,caption_page_index:data.caption_page_index,caption_page_count:data.caption_page_count};renderExternalTools();return;
      }
      if(data.type!=='pia-preview-action'||!verifiedPayload||!lastPreview||data.snapshot_id!==lastPreview.id||renderedPreviewId!==lastPreview.id)return;
      if(data.action==='open-category'){
        const id=data.category_id;if(typeof id!=='string'||!lastPreview.categories.some(item=>item.id===id)||!availableCategories().some(item=>item.id===id))return;
        draft.mode='list';draft.directory_level='scripts';draft.focus_category_id=id;showMode();schedulePreview(true);
      }else if(data.action==='open-script'){
        const id=data.script_id;if(typeof id!=='string'||!lastPreview.scripts.some(script=>script.id===id)||!availableScripts().some(script=>script.id===id))return;
        rememberList();draft.mode='script';draft.script_id=id;draft.directory_level='scripts';draft.focus_category_id=byId(id)?.category_id||null;$('#control-script').value=id;showMode();schedulePreview(true);
      }else if(data.action==='return-list'){
        if(draft.mode==='script'){
          draft.mode='list';draft.directory_level='scripts';draft.focus_category_id=byId(draft.script_id)?.category_id||returnListSelection.focus_category_id||null;
          draft.category_ids=[...returnListSelection.category_ids];$('#list-source').value=returnListSelection.list_source;
          if(draft.category_ids.length&&draft.focus_category_id&&!draft.category_ids.includes(draft.focus_category_id))draft.category_ids.push(draft.focus_category_id);
          if($('#list-source').value==='queue'&&!queueIds().includes(draft.script_id))$('#list-source').value='categories';
        }else{draft.directory_level='categories';draft.focus_category_id=null;}
        renderControlChoices();showMode();showSource();schedulePreview(true);
      }else if(data.action==='font'){
        if(data.delta!==2&&data.delta!==-2)return;const size=Math.min(96,Math.max(16,Number(layout().font_size)+data.delta));
        if(size===Number(layout().font_size))return;draftLayouts[draft.orientation]={...layout(),font_size:size};showLayout();schedulePreview(true);
      }else if(data.action==='apply'){
        if(!Object.prototype.hasOwnProperty.call(data,'anchor'))return;if(Number.isInteger(data.page_index)||data.media_state)previewPositions.set(data.snapshot_id,{anchor:data.anchor,playing:data.playing===true,page_index:data.page_index,media_state:data.media_state});await applyPreview(data.anchor,data.playing===true);
      }
    }));
    click('#toggle-preview-focus',()=>setPreviewFocus(!document.body.classList.contains('preview-focus')));
    const previewPanel=$('.preview-panel');
    previewPanel.addEventListener('click',event=>{
      if(!event.target.closest('button,a,input,select,textarea,summary,[contenteditable],iframe'))previewPanel.focus({preventScroll:true});
    });
    window.addEventListener('keydown',event=>{
      const target=event.target;
      if(event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="slider"]'))return;
      if(event.key==='Escape'&&document.body.classList.contains('preview-focus')){event.preventDefault();setPreviewFocus(false);return;}
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||!previewPanel.contains(target)||!previewReady()||previewTools?.positioning||target.disabled)return;
      event.preventDefault();if(event.repeat)return;
      $('#preview-frame').contentWindow.postMessage({type:'pia-preview-key',snapshot_id:lastPreview.id,key:event.key},location.origin);
    });
    new ResizeObserver(sizePreviewCanvas).observe($('.preview-surround'));
    const previewFrame=$('#preview-frame');
    previewFrame.addEventListener('load',()=>{if(!frameReady){frameReady=true;sendPreviewOptions();sendPreview();}});
    if(previewFrame.contentDocument?.readyState==='complete')frameReady=true;
    click('#apply-display',()=>{
      if(!canApplyPreview())return;
      $('#preview-frame').contentWindow.postMessage({type:'pia-preview-apply-request',snapshot_id:lastPreview.id},location.origin);
    });
    click('#open-display',event=>{
      event.preventDefault();
      const landscape=(liveState?.orientation||draft.orientation)==='landscape';
      const width=Math.min(landscape?1000:560,Math.max(360,(screen.availWidth||1280)-80)),height=Math.min(landscape?620:960,Math.max(420,(screen.availHeight||900)-80));
      const left=(screen.availLeft||0)+Math.max(0,(screen.availWidth||1280)-width-30),top=(screen.availTop||0)+30;
      const audienceWindow=window.open('', 'pia-display',`popup=yes,width=${width},height=${height},left=${left},top=${top}`);
      if(!audienceWindow){toast('展示窗口被浏览器拦截，请允许此本地页面弹出窗口后再试。',true);return;}
      try{
        const current=audienceWindow.location.href;
        if(current==='about:blank')audienceWindow.location.replace(new URL('/display',location.origin).href);
        else if(audienceWindow.location.origin!==location.origin||audienceWindow.location.pathname!=='/display')toast('原展示窗口已跳转到其他页面，请关闭该窗口后重新打开。',true);
        audienceWindow.focus();
      }catch(_){audienceWindow.focus();toast('原展示窗口已跳转到其他页面，请关闭该窗口后重新打开。',true);}
    });
    const command=async(payload)=>{
      const state=await api('/api/command',payload);renderLive(state);
      if(['seek','page','media'].includes(payload.action)&&activePreviewBinding())$('#preview-frame').contentWindow.postMessage({type:'pia-preview-follow-command',snapshot_id:lastPreview.id,action:payload.action,anchor:state.anchor,page_index:state.page_index,media_state:state.media_state,playing:state.playing,speed:state.speed},location.origin);
    };click('#live-play',()=>command({action:'play'}));click('#live-pause',()=>command({action:'pause'}));click('#live-top',()=>command(liveState?.snapshot?.layout?.body_mode==='media'?{action:'media',snapshot_id:liveState.snapshot.id,media_state:{position:0,caption_index:0,caption_page_index:0,cue_id:null},playing:false}:{action:'seek',anchor:null}));click('#live-seek',()=>command({action:'seek',anchor:$('#live-anchor').value||null}));$('#live-speed').addEventListener('input',()=>{$('#live-speed-value').value=$('#live-speed').value+' px/s';});$('#live-speed').addEventListener('change',task(()=>command({action:'speed',speed:Number($('#live-speed').value)})));
    function requestPageStep(direction){
      if(!liveChannel||pendingPageRequest||liveState?.snapshot?.mode!=='script'||liveState.snapshot.layout?.body_mode!=='pages')return;
      const request={type:'page-step',request_id:crypto.randomUUID(),snapshot_id:liveState.snapshot.id,revision:liveState.revision,direction};
      pendingPageRequest=request;renderLivePages();liveChannel.postMessage(request);
      setTimeout(()=>{if(pendingPageRequest?.request_id===request.request_id){pendingPageRequest=null;renderLivePages();toast('未收到展示窗口响应，请先打开展示窗口。',true);}},2500);
    }
    click('#live-previous-page',()=>requestPageStep(-1));click('#live-next-page',()=>requestPageStep(1));
    liveChannel?.addEventListener('message',task(async event=>{
      const data=event.data;
      if(data?.type==='state'&&data.state?.snapshot?.id===liveState?.snapshot?.id&&Number.isSafeInteger(data.state.revision)){renderLive(data.state);return;}
      if(!data||!['page-report','page-status'].includes(data.type)||data.snapshot_id!==liveState?.snapshot?.id||data.revision!==liveState.revision||!Number.isInteger(data.page_index)||!Number.isInteger(data.page_count)||data.page_index<0||data.page_index>=data.page_count||data.page_count>100000)return;
      if(data.type==='page-status'){livePageInfo=data;renderLivePages();return;}
      if(!pendingPageRequest||data.request_id!==pendingPageRequest.request_id||data.snapshot_id!==pendingPageRequest.snapshot_id||data.revision!==pendingPageRequest.revision)return;
      pendingPageRequest=null;renderLivePages();
      await command({action:'page',snapshot_id:data.snapshot_id,page_index:data.page_index,anchor:data.anchor});
    }));
    const sizeControlColumn=()=>{const panel=$('.preview-panel');$('.control-layout').style.setProperty('--control-column-height',Math.floor(panel.getBoundingClientRect().height)+'px');};
    new ResizeObserver(sizeControlColumn).observe($('.preview-panel'));sizeControlColumn();
    renderControlChoices();showMode();showSource();showLayout();sendPreviewOptions();renderLive(liveState);updatePreview();
    let polling=false;setInterval(async()=>{if(polling||document.hidden)return;polling=true;try{const state=await api('/api/state',undefined,'GET');renderLive(state);}catch(err){$('#live-status').textContent='服务连接中断';$('#live-status').className='status-tag error';}finally{polling=false;}},700);
  }

  // Content maintenance. Text always enters the DOM through textContent or escaping.
  let editingBlocks=[], editingScript=null, editingNotesDisplay='',editorSession='';
  function updateRoleOptions(){const node=$('#script-role-options');if(!node)return;const roles=[...new Set(editingBlocks.map(b=>str(b.role).trim()).filter(Boolean))];node.replaceChildren(...roles.map(role=>new Option(role,role)));}
  function refreshManageSelects() { const select=$('#manage-category-filter'), old=select.value;select.innerHTML='<option value="">全部分类</option>'+optionMarkup(library.categories,old); }
  function renderManagedScripts() {
    const q=$('#manage-script-search').value.toLowerCase().trim(),cat=$('#manage-category-filter').value,filter=$('#manage-visible-filter').value;
    const scripts=library.scripts.filter(s=>(!q||[s.title,s.author,s.synopsis,s.cast_note].join(' ').toLowerCase().includes(q))&&(!cat||s.category_id===cat)&&(!filter||(filter==='visible')===visible(s.visible)));
    $('#manage-script-list').innerHTML=scripts.length?scripts.map(s=>`<article class="manage-script-row"><div><h3><a href="/script/${encodeURIComponent(s.id)}">${esc(s.title)}</a></h3><p>${esc(s.author||'作者 / 来源未提供')}</p></div><div class="script-meta"><p>${esc(category(s.category_id)?.name||'未分类')}</p><p>${esc(str(s.cast_note).slice(0,65))}</p></div><span class="visibility${visible(s.visible)?'':' hidden-state'}">${visible(s.visible)?'● 显示中':'○ 已隐藏'}</span><div class="button-row"><a class="button secondary" href="/script/${encodeURIComponent(s.id)}/media">音视频</a><button class="button secondary" data-edit-script="${esc(s.id)}">编辑</button><button class="button secondary" data-toggle-script="${esc(s.id)}">${visible(s.visible)?'隐藏':'恢复显示'}</button></div></article>`).join(''):empty('暂无符合条件的剧本','可调整筛选，或新增剧本。');
  }
  function renderManagedCategories() {
    const q=$('#manage-category-search').value.toLowerCase().trim(),cats=library.categories.filter(c=>!q||c.name.toLowerCase().includes(q));
    $('#manage-category-list').innerHTML=cats.length?cats.map(c=>{const index=library.categories.findIndex(x=>x.id===c.id),count=library.scripts.filter(s=>s.category_id===c.id).length,background=media(c.background);return `<article class="category-row" draggable="${!isSystem(c)&&!q}" data-category-row="${esc(c.id)}"><span class="drag-handle" title="拖动排序" aria-hidden="true">⠿</span>${background?`<img class="category-swatch" src="${esc(background)}" alt="">`:`<span class="category-swatch" style="--category-color:${color(c.color)}"></span>`}<div><h3>${esc(c.name)}${isSystem(c)?' · 系统分类':''}</h3><p>${count} 篇剧本${c.description?' · '+esc(c.description):''}</p></div><span class="visibility${visible(c.visible)?'':' hidden-state'}">${visible(c.visible)?'● 显示中':'○ 已隐藏'}</span><div class="button-row"><button class="icon-button" data-category-move="${esc(c.id)}" data-delta="-1" aria-label="上移 ${esc(c.name)}"${index===0?' disabled':''}>↑</button><button class="icon-button" data-category-move="${esc(c.id)}" data-delta="1" aria-label="下移 ${esc(c.name)}"${index===library.categories.length-1?' disabled':''}>↓</button><button class="button secondary" data-edit-category="${esc(c.id)}">编辑</button>${isSystem(c)?'':`<button class="button secondary" data-delete-category="${esc(c.id)}">删除</button>`}</div></article>`;}).join(''):empty('未找到分类','请调整查找内容。');
  }
  async function refreshLibrary() { library=await api('/api/library',undefined,'GET');if(page==='catalog'){renderCatalog();renderQueue();}if(page==='control'){renderControlChoices();schedulePreview();}if(page==='manage'){refreshManageSelects();renderManagedScripts();renderManagedCategories();} }
  let backgroundAssets=Array.isArray(library.backgrounds)?library.backgrounds:[];
  function showCategoryBackground(){const path=media($('#category-background').value),img=$('#category-background-preview');img.hidden=!path;if(path)img.src=path;else img.removeAttribute('src');}
  function populateCategoryBackgrounds(selected){
    const assets=backgroundAssets.length?backgroundAssets:[...new Map(library.categories.filter(item=>media(item.background)).map(item=>[item.background,{path:item.background,name:item.name+'主题'}])).values()];
    const choices=[...assets];if(selected&&!choices.some(item=>item.path===selected))choices.push({path:selected,name:'当前背景'});
    $('#category-background').innerHTML='<option value="">通用素色（无背景图）</option>'+choices.map(item=>`<option value="${esc(item.path)}"${item.path===selected?' selected':''}>${esc(item.name)}${item.builtin?' · 内置':''}</option>`).join('');showCategoryBackground();
  }
  function backgroundUsage(asset){
    const usage=asset.usage||{},parts=[];
    if(usage.categories?.length)parts.push('分类：'+usage.categories.map(item=>typeof item==='string'?(category(item)?.name||item):(item.name||category(item.id)?.name||item.id)).join('、'));
    if(usage.live)parts.push('当前展示使用中');if(usage.scripts?.length)parts.push(usage.scripts.length+' 篇正文引用');if(usage.history)parts.push(usage.history+' 条历史记录引用');
    return parts.join('；')||'当前没有引用';
  }
  function renderBackgrounds(){
    if(page!=='manage')return;
    $('#background-grid').innerHTML=backgroundAssets.length?backgroundAssets.map(asset=>`<article class="background-card" data-background-id="${esc(asset.id)}"><button type="button" class="background-card-preview" data-preview-background="${esc(asset.id)}" aria-label="预览 ${esc(asset.name)}"><img src="${esc(media(asset.path))}" alt="${esc(asset.name)}" loading="lazy"></button><div class="background-card-body"><h3>${esc(asset.name)}</h3><p>${asset.builtin?'内置背景':'自定义背景'}${asset.width&&asset.height?' · '+asset.width+' × '+asset.height:''}${asset.size?' · '+Math.ceil(asset.size/1024)+' KB':''}</p><p class="background-usage">${esc(backgroundUsage(asset))}</p><div class="button-row"><button type="button" class="button secondary small" data-rename-background="${esc(asset.id)}">重命名</button><button type="button" class="button secondary small" data-delete-background="${esc(asset.id)}"${asset.builtin||asset.can_delete===false?' disabled':''} title="${asset.builtin?'内置背景原件保留':asset.can_delete===false?'素材仍被引用，解除引用后可删除':'删除此素材'}">删除</button></div></div></article>`).join(''):empty('还没有背景素材','可以在上方上传本地图片。');
  }
  async function refreshBackgrounds(){
    const result=await api('/api/backgrounds',undefined,'GET');backgroundAssets=Array.isArray(result.backgrounds)?result.backgrounds:[];library.backgrounds=backgroundAssets;renderBackgrounds();
    if($('#category-dialog')?.open)populateCategoryBackgrounds($('#category-background').value);
  }
  async function uploadBackground(file,name){
    if(!file)throw new Error('请先选择一张背景图片。');if(file.size>12*1024*1024)throw new Error('单张背景图片不能超过 12 MB。');
    const form=new FormData();form.append('file',file);form.append('name',name.trim()||file.name.replace(/\.[^.]+$/,''));return api('/api/backgrounds',form);
  }
  function openCategory(id) {
    const c=id?category(id):{name:'',description:'',color:'#b58a59',background:'',visible:true};$('#category-dialog-title').textContent=id?'编辑分类':'新增分类';$('#category-id').value=id||'';$('#category-name').value=c.name;$('#category-name').readOnly=Boolean(isSystem(c));$('#category-description-input').value=c.description||'';$('#category-color').value=color(c.color);$('#category-visible').checked=visible(c.visible);$('#category-visible').disabled=Boolean(isSystem(c));
    populateCategoryBackgrounds(c.background||'');$('#category-upload-file').value='';$('#category-error').textContent='';$('#category-dialog').showModal();
  }
  function renderBlockEditor() {
    $('#edit-block-count').textContent=`· ${editingBlocks.length} 段`;
    $('#body-editor').innerHTML=editingBlocks.map((b,i)=>`<div class="body-editor-row" data-block-index="${i}"><div class="body-editor-heading"><span>段落 ${i+1}</span><button type="button" class="icon-button" data-remove-block="${i}" aria-label="移除第 ${i+1} 段">移除</button></div>${b.kind==='image'?`<img src="${esc(media(b.image_path))}" alt="原稿插图">`:`<div class="body-editor-fields"><input data-block-role="${i}" list="script-role-options" autocomplete="off" value="${esc(b.role||'')}" placeholder="角色标签（可空）" aria-label="第 ${i+1} 段角色"><input data-block-color="${i}" type="color" value="${color(b.color,'#4b443a')}" aria-label="第 ${i+1} 段配色"></div><textarea data-block-text="${i}" rows="${Math.min(8,Math.max(2,Math.ceil((b.text||'').length/70)))}" aria-label="第 ${i+1} 段正文">${esc(b.text||'')}</textarea>`}</div>`).join('');updateRoleOptions();
  }
  function openScript(id) {
    editorSession=crypto.randomUUID();
    editingScript=id?clone(byId(id)):null;const s=editingScript||{title:'',category_id:library.categories.find(c=>!isSystem(c))?.id||'uncategorized',author:'',synopsis:'',cast_note:'',tags:[],notes:'',visible:true,blocks:[]};editingBlocks=clone(s.blocks||[]);
    $('#script-dialog-title').textContent=id?'编辑剧本':'新增剧本';$('#edit-script-id').value=id||'';$('#edit-title').value=s.title;$('#edit-category').innerHTML=optionMarkup(library.categories,s.category_id);$('#edit-author').value=s.author||'';$('#edit-synopsis').value=s.synopsis||'';$('#edit-cast').value=s.cast_note||'';$('#edit-tags').value=(s.tags||[]).join('，');editingNotesDisplay=displayNotes(s.notes);$('#edit-notes').value=editingNotesDisplay;$('#edit-visible').checked=visible(s.visible);$('#script-source-note').textContent=id?'编辑不会覆盖原始证据文件。':'新内容作为手动录入保存。';$('#script-error').textContent='';$('#body-editor-details').open=!id;renderBlockEditor();$('#script-dialog').showModal();
  }
  async function reorderCategories(ids) { await api('/api/categories/reorder',{ids});await refreshLibrary();toast('分类顺序已保存'); }
  if(page==='manage') {
    window.piaEditor={
      getDraft(){if(!$('#script-dialog').open)throw new Error('请先新建或编辑一个剧本。');return {session_id:editorSession,title:$('#edit-title').value,author:$('#edit-author').value,blocks:clone(editingBlocks)};},
      applyImport({candidate,mode='append',session_id}){
        if(!$('#script-dialog').open||session_id!==editorSession)throw new Error('正在编辑的剧本已切换，请重新识别后导入。');
        if(!candidate||!Array.isArray(candidate.blocks)||!['append','replace'].includes(mode))throw new Error('导入内容无效。');
        const incoming=candidate.blocks.map(b=>({id:'block-'+crypto.randomUUID(),kind:'text',text:str(b.text),role:str(b.role),color:color(b.color,'#4b443a')}));
        if(!incoming.length)throw new Error('没有可导入的正文。');
        editingBlocks=mode==='replace'?[...incoming,...editingBlocks.filter(b=>b.kind==='image')]:[...editingBlocks,...incoming];
        if(!$('#edit-title').value.trim()&&candidate.title)$('#edit-title').value=candidate.title;
        if(!$('#edit-author').value.trim()&&candidate.author)$('#edit-author').value=candidate.author;
        $('#body-editor-details').open=true;renderBlockEditor();toast('内容已填入草稿，检查后点击保存剧本。');
      }
    };
    $$('[data-tab]').forEach(button=>button.addEventListener('click',()=>{$$('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));['scripts','categories','backgrounds','backup'].forEach(id=>{$('#manage-'+id).hidden=id!==button.dataset.tab;});}));
    $('#tab-backgrounds').addEventListener('click',task(()=>refreshBackgrounds()));
    $('#category-background').addEventListener('change',showCategoryBackground);
    $('#background-upload-form').addEventListener('submit',async event=>{
      event.preventDefault();const button=$('#background-upload-button');button.disabled=true;$('#background-upload-status').textContent='正在上传并检查图片…';
      try{await uploadBackground($('#background-upload-file').files[0],$('#background-upload-name').value);await refreshBackgrounds();$('#background-upload-form').reset();$('#background-upload-status').textContent='背景已加入素材库，可在分类编辑中选用。';}
      catch(err){$('#background-upload-status').textContent=err.message;toast(err.message,true);}finally{button.disabled=false;}
    });
    click('#category-upload-button',async()=>{
      const button=$('#category-upload-button');button.disabled=true;
      try{const asset=await uploadBackground($('#category-upload-file').files[0],'');await refreshBackgrounds();populateCategoryBackgrounds(asset.path);$('#category-upload-file').value='';toast('背景已上传并选中，保存分类后生效。');}finally{button.disabled=false;}
    });
    $('#background-grid').addEventListener('click',task(async event=>{
      const preview=event.target.closest('[data-preview-background]');if(preview){const asset=backgroundAssets.find(item=>item.id===preview.dataset.previewBackground);if(asset){$('#background-preview-title').textContent=asset.name;$('#background-preview-image').src=media(asset.path);$('#background-preview-dialog').showModal();}return;}
      const rename=event.target.closest('[data-rename-background]');if(rename){const asset=backgroundAssets.find(item=>item.id===rename.dataset.renameBackground);if(asset){$('#background-rename-id').value=asset.id;$('#background-rename-name').value=asset.name;$('#background-rename-error').textContent='';$('#background-rename-dialog').showModal();}return;}
      const remove=event.target.closest('[data-delete-background]');if(remove&&!remove.disabled){const asset=backgroundAssets.find(item=>item.id===remove.dataset.deleteBackground);if(!asset)return;if(await confirmAction('删除背景“'+asset.name+'”？','删除只影响这份自定义素材，原始证据文件保持不变。',{label:'删除背景'})){await api('/api/backgrounds/'+encodeURIComponent(asset.id),{},'DELETE');await refreshBackgrounds();toast('背景素材已删除。');}}
    }));
    $('#background-rename-form').addEventListener('submit',async event=>{event.preventDefault();try{await api('/api/backgrounds/'+encodeURIComponent($('#background-rename-id').value),{name:$('#background-rename-name').value.trim()},'PATCH');$('#background-rename-dialog').close();await refreshBackgrounds();toast('素材名称已保存。');}catch(err){$('#background-rename-error').textContent=err.message;}});
    click('#new-category',()=>openCategory());click('#new-script',()=>openScript());$('#manage-script-search').addEventListener('input',renderManagedScripts);$('#manage-category-filter').addEventListener('change',renderManagedScripts);$('#manage-visible-filter').addEventListener('change',renderManagedScripts);$('#manage-category-search').addEventListener('input',renderManagedCategories);
    document.addEventListener('click',task(async e=>{
      const editCat=e.target.closest('[data-edit-category]');if(editCat)openCategory(editCat.dataset.editCategory);
      const edit=e.target.closest('[data-edit-script]');if(edit)openScript(edit.dataset.editScript);
      const toggle=e.target.closest('[data-toggle-script]');if(toggle){const s=byId(toggle.dataset.toggleScript);await api('/api/scripts/'+encodeURIComponent(s.id),{visible:!visible(s.visible)},'PATCH');await refreshLibrary();toast(visible(s.visible)?'剧本已隐藏，可随时恢复。':'剧本已恢复显示。');}
      const remove=e.target.closest('[data-delete-category]');if(remove){const c=category(remove.dataset.deleteCategory),count=library.scripts.filter(s=>s.category_id===c.id).length;const target=await confirmAction('删除“'+c.name+'”？',count?`这个分类中有 ${count} 篇剧本（含隐藏）。请选择承接分类，剧本会先转移，不会被删除。`:'这是一个空分类，删除后可重新创建。已上屏画面保持不变。',{label:'确认删除',choices:count?library.categories.filter(x=>x.id!==c.id&&visible(x.visible)).map(x=>({value:x.id,label:x.name})):null});if(target!==null){await api('/api/categories/'+encodeURIComponent(c.id),{target_id:typeof target==='string'?target:'uncategorized'},'DELETE');await refreshLibrary();toast('分类已删除，关联剧本已保留。');}}
      const move=e.target.closest('[data-category-move]');if(move){const ids=library.categories.map(c=>c.id),i=ids.indexOf(move.dataset.categoryMove),j=i+Number(move.dataset.delta);if(j>=0&&j<ids.length){[ids[i],ids[j]]=[ids[j],ids[i]];await reorderCategories(ids);}}
      const removeBlock=e.target.closest('[data-remove-block]');if(removeBlock){if(await confirmAction('移除正文段落？','移除仅在保存剧本后生效。原始 PPT 证据不会改变。',{label:'移除此段'})){editingBlocks.splice(Number(removeBlock.dataset.removeBlock),1);renderBlockEditor();}}
    }));
    $('#category-form').addEventListener('submit',async e=>{e.preventDefault();const id=$('#category-id').value,data={name:$('#category-name').value.trim(),description:$('#category-description-input').value,color:$('#category-color').value,background:$('#category-background').value,visible:$('#category-visible').checked};try{await api('/api/categories'+(id?'/'+encodeURIComponent(id):''),data,id?'PATCH':'POST');$('#category-dialog').close();await refreshLibrary();toast('分类已保存；当前上屏内容保持不变。');}catch(err){$('#category-error').textContent=err.message;}});
    $('#body-editor').addEventListener('input',e=>{const t=e.target;if(t.dataset.blockText!==undefined){const b=editingBlocks[Number(t.dataset.blockText)];b.text=t.value;if(b.runs?.map(r=>r.text).join('')!==t.value)b.runs=[{text:t.value,color:b.color||''}];}if(t.dataset.blockRole!==undefined){editingBlocks[Number(t.dataset.blockRole)].role=t.value;updateRoleOptions();}if(t.dataset.blockColor!==undefined){const b=editingBlocks[Number(t.dataset.blockColor)];b.color=t.value;b.runs=[{text:b.text,color:t.value}];}});
    click('#add-block',()=>{editingBlocks.push({id:'block-'+(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)),kind:'text',text:'',role:'',color:'#4b443a',source_page:null,source_file:'',runs:[]});renderBlockEditor();$$('#body-editor textarea').at(-1)?.focus();});
    $('#script-form').addEventListener('submit',async e=>{e.preventDefault();const id=$('#edit-script-id').value,data={title:$('#edit-title').value.trim(),category_id:$('#edit-category').value,author:$('#edit-author').value,synopsis:$('#edit-synopsis').value,cast_note:$('#edit-cast').value,tags:$('#edit-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean),notes:editingScript&&$('#edit-notes').value===editingNotesDisplay?editingScript.notes:$('#edit-notes').value,visible:$('#edit-visible').checked,blocks:editingBlocks};try{await api('/api/scripts'+(id?'/'+encodeURIComponent(id):''),data,id?'PATCH':'POST');$('#script-dialog').close();await refreshLibrary();toast('剧本已保存；重新应用后更新展示。');}catch(err){$('#script-error').textContent=err.message;}});
    let dragged=null;$('#manage-category-list').addEventListener('dragstart',e=>{const row=e.target.closest('[data-category-row]');if(!row||row.draggable===false)return;dragged=row.dataset.categoryRow;row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',dragged);});$('#manage-category-list').addEventListener('dragover',e=>{const row=e.target.closest('[data-category-row]');if(!dragged||!row)return;e.preventDefault();$$('.category-row.drag-over').forEach(x=>x.classList.remove('drag-over'));row.classList.add('drag-over');});$('#manage-category-list').addEventListener('dragend',()=>{dragged=null;$$('.category-row').forEach(x=>x.classList.remove('drag-over','dragging'));});$('#manage-category-list').addEventListener('drop',task(async e=>{e.preventDefault();const row=e.target.closest('[data-category-row]');if(!dragged||!row||row.dataset.categoryRow===dragged)return;const ids=library.categories.map(c=>c.id),from=ids.indexOf(dragged),to=ids.indexOf(row.dataset.categoryRow);ids.splice(from,1);ids.splice(to,0,dragged);dragged=null;await reorderCategories(ids);}));
    click('#restore-backup',async()=>{const file=$('#restore-file').files[0];if(!file){toast('请先选择本项目导出的 ZIP 备份。',true);return;}if(!await confirmAction('恢复备份并替换当前资料？','剧本、分类、设置和本场列表将被这份备份替换。建议先下载当前备份。恢复后展示会暂停。',{label:'确认恢复'}))return;const form=new FormData();form.append('file',file);$('#restore-backup').disabled=true;$('#restore-status').textContent='正在检查并恢复备份…';try{await api('/api/restore',form);await refreshLibrary();$('#restore-status').textContent='恢复完成。资料已重新载入，展示保持暂停。';toast('备份已恢复');}catch(err){$('#restore-status').textContent='恢复未完成：'+err.message;throw err;}finally{$('#restore-backup').disabled=false;}});
    refreshManageSelects();renderManagedScripts();renderManagedCategories();renderBackgrounds();refreshBackgrounds().catch(err=>toast(err.message,true));
  }

  // Reflect edits from another operator tab without publishing any draft.
  let lastLibraryFingerprint=JSON.stringify([library.categories,library.scripts,library.queue]),refreshing=false;
  if(page==='catalog'||page==='control')setInterval(async()=>{if(refreshing||document.hidden)return;refreshing=true;try{const next=await api('/api/library',undefined,'GET'),fingerprint=JSON.stringify([next.categories,next.scripts,next.queue]);if(fingerprint!==lastLibraryFingerprint){lastLibraryFingerprint=fingerprint;library=next;if(page==='catalog'){renderCatalog();renderQueue();}else{renderControlChoices();schedulePreview();}}}catch(_){/* live controls already report connection failures */}finally{refreshing=false;}},4500);
})();
