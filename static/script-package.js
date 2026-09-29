(() => {
  'use strict';
  const dialog = document.querySelector('#script-package-dialog');
  if (!dialog) return;
  const $ = selector => dialog.querySelector(selector);
  let version = 0, openEpoch = 0, controller = null, candidate = null;
  let checking = false, importing = false, importedId = null, categoriesReady = false;
  const error = value => { $('#script-package-error').textContent = value || ''; };
  const status = value => { $('#script-package-status').textContent = value || ''; };
  const controls = () => {
    $('#script-package-check').disabled = importing || checking || !categoriesReady;
    $('#script-package-check').textContent = checking ? '正在检查…' : '检查文件';
    $('#script-package-file').disabled = importing;
    $('#script-package-category').disabled = importing;
    $('#script-package-confirm').disabled = importing || checking || !candidate || !$('#script-package-category').value || !!importedId;
    $('#script-package-confirm').textContent = importing ? '正在导入…' : '作为新剧本导入';
    for (const button of dialog.querySelectorAll('[data-package-close]')) button.disabled = importing;
    dialog.setAttribute('aria-busy', String(checking || importing));
  };
  function invalidate() {
    ++version; controller?.abort(); controller = null; candidate = null; checking = false;
    importedId = null; $('#script-package-edit-imported').hidden = true;
    $('#script-package-preview').hidden = true; error(''); status(''); controls();
  }
  function close() { if (!importing) { ++openEpoch; invalidate(); dialog.close(); } }
  async function open() {
    if (dialog.open) return;
    invalidate(); categoriesReady = false; $('#script-package-file').value = '';
    $('#script-package-category').replaceChildren(new Option('请选择接收分类', ''));
    const epoch = ++openEpoch; dialog.showModal(); controls(); status('正在读取现有分类…');
    try {
      const categories = await window.piaScriptPackages.categories();
      if (epoch !== openEpoch || !dialog.open) return;
      for (const category of categories) {
        $('#script-package-category').add(new Option(category.name + (category.visible === false || category.visible === 0 ? '（已隐藏）' : ''), category.id));
      }
      categoriesReady = true; status('先选择单篇剧本 ZIP，再检查文件。'); controls(); $('#script-package-file').focus();
    } catch (failure) {
      if (epoch === openEpoch && dialog.open) { error('无法读取分类：' + failure.message + ' 请关闭后重试。'); status(''); }
    }
  }
  async function request(path, body, signal) {
    let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try { response = await fetch(path, {method: 'POST', credentials: 'same-origin', signal, headers: {'X-CSRF-Token': csrf}, body}); }
      catch (failure) {
        if (failure.name === 'AbortError') throw failure;
        throw new Error('暂时无法连接本地服务，请检查工作台是否仍在运行。');
      }
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error('服务返回了无效响应，请核对剧本列表后重试。'); }
      if (response.ok) return payload;
      if (attempt === 0 && response.status === 403 && payload.code === 'csrf_failed') {
        const refresh = await fetch('/api/library', {credentials: 'same-origin', signal, cache: 'no-store'});
        if (refresh.ok) {
          csrf = (await refresh.json()).csrf_token || csrf;
          const meta = document.querySelector('meta[name="csrf-token"]'); if (meta) meta.content = csrf;
          continue;
        }
      }
      throw new Error(payload.error || `操作未完成（${response.status}），请检查是否为单篇剧本导出文件。`);
    }
  }
  function element(tag, className, text) {
    const node = document.createElement(tag); node.className = className; node.textContent = text ?? ''; return node;
  }
  function render(data) {
    if (!data.script || !Array.isArray(data.script.blocks) || !/^[a-f0-9]{64}$/i.test(data.package_sha256 || '')) throw new Error('文件检查响应缺少剧本或校验信息，请重新检查。');
    candidate = data;
    $('#script-package-title').textContent = data.title || data.script.title;
    $('#script-package-author').textContent = '作者 / 来源：' + (data.author || '未提供');
    $('#script-package-origin').textContent = '原分类：' + (data.category_name || '未提供');
    $('#script-package-summary').textContent = `${data.text_blocks} 个文字段落 · ${data.image_blocks} 张正文图片 · ${data.has_media ? '附音视频' : '无音视频'} · ${data.cue_count} 个时间点`;
    const warnings = [...(Array.isArray(data.warnings) ? data.warnings : [])];
    if (!Array.isArray(data.warnings) && data.duplicate_title_count > 0) warnings.push(`当前资料已有 ${data.duplicate_title_count} 篇同名剧本；确认后会新增一篇，不覆盖已有内容。`);
    if (!Array.isArray(data.warnings) && (data.visible === false || data.visible === 0 || data.script.visible === false || data.script.visible === 0)) warnings.push('这篇剧本原来处于隐藏状态，导入后保留隐藏，可在内容管理中恢复显示。');
    $('#script-package-warnings').replaceChildren(...[...new Set(warnings)].map(value => element('li', '', value)));
    $('#script-package-warnings').hidden = !warnings.length;
    const fragment = document.createDocumentFragment();
    if (data.script.synopsis) fragment.append(element('p', 'help', '简介：' + data.script.synopsis));
    data.script.blocks.slice(0, 200).forEach((block, index) => {
      const row = element('article', 'script-package-block', '');
      row.append(element('strong', '', `段落 ${index + 1}${block.role ? ' · ' + block.role : ''}`));
      row.append(element('p', '', block.kind === 'image' ? '图片段落（图片文件随本导入）' : block.text));
      fragment.append(row);
    });
    if (data.script.blocks.length > 200) fragment.append(element('p', 'help', '这里显示前200个段落；导入时保留完整正文。'));
    if (data.script.media) {
      const media = data.script.media;
      fragment.append(element('p', 'help', '关联音视频：' + (media.original_name || media.filename || media.name || '本地媒体文件')));
      for (const cue of (media.cues || [])) {
        fragment.append(element('p', 'script-package-cue', `${cue.at} 秒 · ${cue.name || cue.label || '暂停点'} · ${(cue.block_ids || []).length} 个正文段落`));
      }
    }
    $('#script-package-content').replaceChildren(fragment);
    $('#script-package-preview').hidden = false;
    status('检查完成，尚未写入资料。请选择接收分类后确认导入。');
  }
  async function check() {
    if (importing || checking || !categoriesReady) return;
    invalidate();
    const file = $('#script-package-file').files[0];
    if (!file) { error('请先选择单篇剧本 ZIP。'); return; }
    if (!/\.zip$/i.test(file.name)) { error('请选择从工作台导出的单篇剧本 ZIP。'); return; }
    const epoch = version; controller = new AbortController(); checking = true; controls(); status('正在检查正文与附带资源…');
    const body = new FormData(); body.append('file', file);
    try {
      const data = await request('/api/script-packages/preview', body, controller.signal);
      if (epoch !== version || !dialog.open) return;
      render(data);
    } catch (failure) {
      if (epoch === version && failure.name !== 'AbortError') { candidate = null; error(failure.message); status(''); }
    } finally {
      if (epoch === version) { controller = null; checking = false; controls(); }
    }
  }
  async function editImported() {
    if (!importedId || importing) return;
    const button = $('#script-package-edit-imported'); button.disabled = true;
    try { await window.piaScriptPackages.editImported(importedId); }
    catch (failure) { error('剧本已经导入，列表刷新暂未完成：' + failure.message + ' 请点击“编辑已导入剧本”重试。'); }
    finally { button.disabled = false; }
  }
  async function confirmImport() {
    if (importing || checking || !candidate || importedId) return;
    const file = $('#script-package-file').files[0], category = $('#script-package-category').value;
    if (!file || !category) { error('请检查文件并选择接收分类。'); return; }
    const body = new FormData(); body.append('file', file); body.append('category_id', category); body.append('expected_sha256', candidate.package_sha256);
    importing = true; controls(); error(''); status('正在保存新剧本和资源，请稍候…');
    try {
      const data = await request('/api/script-packages/import', body);
      if (!data.script?.id) throw new Error('服务未返回新剧本标识。');
      importedId = data.script.id; candidate = null;
      $('#script-package-edit-imported').hidden = false;
      status('新剧本已保存，正在刷新资料列表…');
    } catch (failure) {
      candidate = null;
      error(failure.message + ' 未确认导入结果；请先检查剧本列表，避免重复导入。需要重试时重新检查文件。');
      status('');
    } finally { importing = false; controls(); }
    if (importedId) await editImported();
  }
  document.querySelector('#open-script-package')?.addEventListener('click', open);
  for (const button of dialog.querySelectorAll('[data-package-close]')) button.addEventListener('click', close);
  $('#script-package-file').addEventListener('change', () => { if (!importing) { invalidate(); status('文件已选择，请点击“检查文件”。'); } });
  $('#script-package-check').addEventListener('click', check);
  $('#script-package-category').addEventListener('change', controls);
  $('#script-package-confirm').addEventListener('click', confirmImport);
  $('#script-package-edit-imported').addEventListener('click', editImported);
  dialog.addEventListener('cancel', event => { if (importing) event.preventDefault(); else close(); });
  dialog.addEventListener('close', () => { ++openEpoch; invalidate(); });
})();
