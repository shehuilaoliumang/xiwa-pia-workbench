(() => {
  'use strict';
  const dialog = document.querySelector('#library-merge-dialog'); if (!dialog) return;
  const $ = selector => dialog.querySelector(selector);
  let generation = 0, openGeneration = 0, controller = null, candidate = null, localCategories = [];
  let checking = false, importing = false, finished = false, requestId = null;
  const selections = new Map(), categoryMapping = new Map();
  const text = (selector, value) => { $(selector).textContent = value || ''; };
  function node(tag, className, value) { const element = document.createElement(tag); element.className = className || ''; element.textContent = value || ''; return element; }
  const validCategory = id => localCategories.some(category => category.id === id);
  const currentItems = () => candidate?.items || [];
  function decisions() {
    return currentItems().map(item => {
      const choice = selections.get(item.source_id), match = (item.matches || []).find(value => value.id === choice.target_id);
      return {source_id:item.source_id,action:choice.action,category_id:choice.action === 'new' ? (categoryMapping.get(item.category_id) || '') : choice.category_id || '',target_id:choice.target_id || '',expected_target_fingerprint:match?.fingerprint || ''};
    });
  }
  function controls() {
    $('#library-merge-check').disabled = importing || checking || !localCategories.length;
    $('#library-merge-check').textContent = checking ? '正在检查…' : '检查备份';
    $('#library-merge-file').disabled = importing;
    for (const control of dialog.querySelectorAll('#library-merge-preview select, #library-merge-overwrite-confirm')) control.disabled = importing || checking || finished;
    for (const button of dialog.querySelectorAll('[data-library-merge-close]')) button.disabled = importing;
    const values = decisions(), overwrites = values.filter(value => value.action === 'overwrite');
    const incomplete = values.some(value => (value.action === 'new' && !validCategory(value.category_id)) || (value.action === 'overwrite' && (!value.target_id || !value.expected_target_fingerprint || !validCategory(value.category_id))));
    const targets = overwrites.map(value => value.target_id).filter(Boolean), repeated = targets.length !== new Set(targets).size;
    const newTitles = values.filter(value => value.action === 'new').map(value => currentItems().find(item => item.source_id === value.source_id).title.trim().toLocaleLowerCase());
    const repeatedNew = newTitles.length !== new Set(newTitles).size;
    $('#library-merge-confirm').disabled = importing || checking || finished || !candidate || incomplete || repeated || repeatedNew || (overwrites.length > 0 && !$('#library-merge-overwrite-confirm').checked);
    $('#library-merge-confirm').textContent = importing ? '正在合并…' : (values.length && values.every(value => value.action === 'skip') ? '确认全部跳过' : '确认合并');
    $('#library-merge-overwrite-field').hidden = !overwrites.length;
    dialog.setAttribute('aria-busy', String(checking || importing));
    renderReview(values, repeated, repeatedNew);
  }
  function invalidate() {
    ++generation; controller?.abort(); controller = null; candidate = null; checking = false; finished = false; requestId = null;
    selections.clear(); categoryMapping.clear(); $('#library-merge-preview').hidden = true; $('#library-merge-overwrite-confirm').checked = false;
    text('#library-merge-error',''); text('#library-merge-status',''); controls();
  }
  function close() { if (!importing) { ++openGeneration; invalidate(); dialog.close(); } }
  async function open() {
    if (dialog.open) return;
    invalidate(); localCategories = []; $('#library-merge-file').value = ''; const epoch = ++openGeneration;
    dialog.showModal(); controls(); text('#library-merge-status','正在读取本地分组…');
    try {
      const categories = await window.wbScriptPackages.categories();
      if (epoch !== openGeneration || !dialog.open) return;
      localCategories = categories; text('#library-merge-status','先选择完整备份，再检查。检查和取消都不会写入资料。'); controls(); $('#library-merge-file').focus();
    } catch (failure) { if (epoch === openGeneration && dialog.open) text('#library-merge-error','无法读取本地分组：' + failure.message); }
  }
  async function request(path, body, signal) {
    let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    for (let attempt=0;attempt<2;attempt++) {
      let response;
      try { response = await fetch(path,{method:'POST',credentials:'same-origin',signal,headers:{'X-CSRF-Token':csrf},body}); }
      catch (failure) { if (failure.name === 'AbortError') throw failure; throw new Error('暂时无法连接本地服务，请检查工作台是否仍在运行。'); }
      let payload; try { payload = await response.json(); } catch (_) { throw new Error('服务响应无效，请核对资料列表后重试。'); }
      if (response.ok) return payload;
      if (attempt === 0 && response.status === 403 && payload.code === 'csrf_failed') {
        const refresh = await fetch('/api/library',{credentials:'same-origin',cache:'no-store',signal});
        if (refresh.ok) { csrf = (await refresh.json()).csrf_token || csrf; const meta = document.querySelector('meta[name="csrf-token"]'); if (meta) meta.content = csrf; continue; }
      }
      const failure = new Error(payload.error || `操作未完成（${response.status}）。`); failure.code = payload.code; failure.status = response.status; throw failure;
    }
  }
  function categoryOptions(select, chosen = '') {
    select.replaceChildren(new Option('请选择本地已有分组',''),...localCategories.map(category => new Option(category.name + (category.visible === false || category.visible === 0 ? '（已隐藏）' : ''),category.id)));
    if (validCategory(chosen)) select.value = chosen;
  }
  function altered() { $('#library-merge-overwrite-confirm').checked = false; text('#library-merge-error',''); controls(); }
  function renderComparison(item, holder, selected = '') {
    const rows = (item.matches || []).filter(match => !selected || match.id === selected).map(match => {
      const row = node('article','library-merge-match',''); row.append(node('strong','',`${match.title || item.title} · ${match.category_name || '未分组'}`));
      row.append(node('p','',`现有条目标识：${match.id}`));
      const changes = (match.changes || []).map(value => typeof value === 'string' ? value : value.label || value.field);
      row.append(node('p','',match.identical ? '内容和关联资源完全相同，本次跳过。' : '将变化：' + (changes.join('、') || '资料或正文内容'))); return row;
    }); holder.replaceChildren(...rows);
  }
  function render(data, saved = {}) {
    if (!Array.isArray(data.items) || !Array.isArray(data.categories) || !/^[a-f0-9]{64}$/i.test(data.package_sha256 || '') || new Set(data.items.map(item => item.source_id)).size !== data.items.length) throw new Error('检查结果缺少条目或校验信息，请重新检查。');
    candidate = data; requestId = crypto.randomUUID();
    for (const category of data.categories) categoryMapping.set(category.id, validCategory(saved.categories?.[category.id]) ? saved.categories[category.id] : (validCategory(category.suggested_category_id) ? category.suggested_category_id : ''));
    const mappings = data.categories.map(category => {
      const label = node('label','field',`备份分组：${category.name || '未分组'} → 本地分组`), select = node('select','','');
      select.dataset.sourceCategory = category.id; select.setAttribute('aria-label',`接收分组：${category.name || '未分组'}`); categoryOptions(select,categoryMapping.get(category.id));
      select.addEventListener('change',() => { categoryMapping.set(category.id,select.value); altered(); }); label.append(select); return label;
    }); $('#library-merge-categories').replaceChildren(...mappings);
    const rows = data.items.map((item,index) => {
      const prior = saved.items?.[item.source_id] || {}, actions = item.status === 'new' ? [['new','新增条目'],['skip','跳过']] : item.status === 'conflict' ? [['skip','跳过，保留现有资料'],['overwrite','覆盖所内容管理地条目']] : [['skip','跳过完全相同的条目']];
      const choice = {action:actions.some(([value]) => value === prior.action) ? prior.action : (item.default_action || (item.status === 'new' ? 'new' : 'skip')),target_id:(item.matches || []).some(match => match.id === prior.target_id) ? prior.target_id : '',category_id:validCategory(prior.category_id) ? prior.category_id : ''};
      selections.set(item.source_id,choice);
      const row = node('article','library-merge-item',''); row.dataset.sourceId = item.source_id;
      row.append(node('h4','',`${index+1}. ${item.title}`)); row.append(node('p','help',`备份分组：${item.category_name || '未分组'} · ${item.status === 'duplicate' ? '完全相同，跳过' : item.status === 'conflict' ? '同名但内容不同，默认跳过' : '可新增'}`));
      if (item.package_title_conflict) row.append(node('p','help','备份中有另一篇同名条目：此篇默认跳过。同一批次只能选择其中一篇新增。'));
      const fields = node('div','library-merge-item-fields',''), actionLabel = node('label','field','处理方式'), actionSelect = node('select','','');
      actionSelect.dataset.mergeAction = item.source_id; actionSelect.setAttribute('aria-label',`处理方式：${item.title}`); actionSelect.replaceChildren(...actions.map(([value,label]) => new Option(label,value))); actionSelect.value = choice.action; actionLabel.append(actionSelect); fields.append(actionLabel);
      const targetLabel = node('label','field','明确选择要覆盖的本地条目'), target = node('select','',''); target.dataset.mergeTarget = item.source_id; target.setAttribute('aria-label',`覆盖目标：${item.title}`);
      target.replaceChildren(new Option('请选择一篇，系统不会自动选择',''),...(item.matches || []).map(match => new Option(`${match.title || item.title} · ${match.category_name || '未分组'} · ${match.id}`,match.id))); target.value = choice.target_id; targetLabel.append(target); fields.append(targetLabel);
      const categoryLabel = node('label','field','覆盖后保存在本地分组'), category = node('select','',''); category.dataset.mergeCategory = item.source_id; categoryOptions(category,choice.category_id); categoryLabel.append(category); fields.append(categoryLabel); row.append(fields);
      const comparison = node('div','',''); row.append(comparison);
      const updateVisibility = () => { targetLabel.hidden = choice.action !== 'overwrite'; categoryLabel.hidden = choice.action !== 'overwrite'; renderComparison(item,comparison,choice.target_id); };
      actionSelect.addEventListener('change',() => { choice.action = actionSelect.value; updateVisibility(); altered(); });
      target.addEventListener('change',() => { choice.target_id = target.value; const match = (item.matches || []).find(value => value.id === choice.target_id); choice.category_id = match?.category_id || ''; category.value = choice.category_id; updateVisibility(); altered(); });
      category.addEventListener('change',() => { choice.category_id = category.value; altered(); }); updateVisibility(); return row;
    }); $('#library-merge-items').replaceChildren(...rows);
    $('#library-merge-overwrite-confirm').checked = false; $('#library-merge-preview').hidden = false;
    text('#library-merge-count',`${data.items.length} 篇：${data.items.filter(item=>item.status==='new').length} 篇可新增，${data.items.filter(item=>item.status==='duplicate').length} 篇完全相同，${data.items.filter(item=>item.status==='conflict').length} 篇同名待核对。`);
    text('#library-merge-status','检查完成，尚未保存。请逐篇核对，确认后一次保存。'); controls();
  }
  function renderReview(values, repeated, repeatedNew) {
    const added = values.filter(value=>value.action==='new').length, overwritten = values.filter(value=>value.action==='overwrite').length, skipped = values.filter(value=>value.action==='skip').length;
    const holder = $('#library-merge-review'); holder.replaceChildren(node('strong','',`本次计划：新增 ${added} 篇 · 覆盖 ${overwritten} 篇 · 跳过 ${skipped} 篇`));
    if (repeated) holder.append(node('p','form-error','两篇备份不能同时覆盖同一个本地条目，请调整覆盖目标或跳过其中一篇。'));
    if (repeatedNew) holder.append(node('p','form-error','同一批次有多篇同名条目选择了新增，请只保留一篇新增，其他同名篇先跳过。'));
    const list = node('ul','','');
    for (const value of values.filter(value=>value.action==='overwrite')) {
      const item = currentItems().find(item=>item.source_id===value.source_id), match = (item.matches || []).find(match=>match.id===value.target_id);
      list.append(node('li','',`${item.title} → ${match ? `${match.title}（${match.category_name}，${match.id}）` : '尚未选择目标'}；接收分组：${localCategories.find(category=>category.id===value.category_id)?.name || '尚未选择'}；变化：${(match?.changes || []).map(change=>typeof change==='string'?change:change.label || change.field).join('、') || '请先选择目标查看'}`));
    } if (overwritten) holder.append(list);
  }
  async function check(saved = {}) {
    if (importing || checking || !localCategories.length) return;
    invalidate(); const file = $('#library-merge-file').files[0];
    if (!file || !/\.zip$/i.test(file.name)) { text('#library-merge-error','请选择本项目导出的完整备份 ZIP。'); return; }
    const epoch = generation; checking = true; controller = new AbortController(); controls(); text('#library-merge-status','正在核对备份条目和关联资源…');
    const body = new FormData(); body.append('file',file);
    try { const data = await request('/api/library-merge/preview',body,controller.signal); if (epoch !== generation || !dialog.open) return; render(data,saved); }
    catch (failure) { if (epoch === generation && failure.name !== 'AbortError') { candidate = null; text('#library-merge-error',failure.message); text('#library-merge-status',''); } }
    finally { if (epoch === generation) { checking = false; controller = null; controls(); } }
  }
  async function confirm() {
    if (importing || checking || !candidate || finished || $('#library-merge-confirm').disabled) return;
    const file = $('#library-merge-file').files[0]; if (!file) return;
    const values = decisions(), saved = {categories:Object.fromEntries(categoryMapping),items:Object.fromEntries(selections)};
    const body = new FormData(); body.append('file',file); body.append('expected_sha256',candidate.package_sha256); body.append('decisions',JSON.stringify(values)); body.append('request_id',requestId);
    importing = true; controls(); text('#library-merge-error',''); text('#library-merge-status','正在一次保存合并结果，请稍候…'); let stale = false;
    try {
      const result = await request('/api/library-merge/import',body); finished = true;
      text('#library-merge-status',`已完成：新增 ${result.added || 0} 篇，覆盖 ${result.overwritten || 0} 篇，跳过 ${result.skipped || 0} 篇。`);
      try { await window.wbScriptPackages.refreshLibrary(); }
      catch (failure) { text('#library-merge-error','合并已完成，列表刷新暂未完成：' + failure.message + ' 请关闭此窗口后刷新页面。'); }
    } catch (failure) {
      stale = failure.status === 409 && /changed|stale|conflict|preview_required/.test(failure.code || '');
      if (!stale) { text('#library-merge-error',failure.message + ' 请核对列表后重试；新增内容会再次检查重复，避免重复保存。'); text('#library-merge-status',''); }
    } finally { importing = false; controls(); }
    if (stale) { await check(saved); text('#library-merge-error','检查后本地资料或文件发生变化，已重新核对并保留有效选择。请再次确认覆盖差异。'); }
  }
  document.querySelector('#open-library-merge')?.addEventListener('click',open);
  for (const button of dialog.querySelectorAll('[data-library-merge-close]')) button.addEventListener('click',close);
  $('#library-merge-file').addEventListener('change',() => { if (!importing) { invalidate(); text('#library-merge-status','文件已选择，请检查备份。'); } });
  $('#library-merge-check').addEventListener('click',() => check()); $('#library-merge-confirm').addEventListener('click',confirm);
  $('#library-merge-overwrite-confirm').addEventListener('change',controls);
  dialog.addEventListener('cancel',event => { if (importing) event.preventDefault(); else close(); });
  dialog.addEventListener('close',() => { ++openGeneration; invalidate(); });
})();
