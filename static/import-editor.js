(() => {
  'use strict';
  const dialog = document.querySelector('#import-editor-dialog');
  if (!dialog) return;
  const $ = selector => dialog.querySelector(selector);
  let draft = null, candidate = null, requestVersion = 0, pending = null, source = 'paste';
  const error = message => { $('#import-error').textContent = message || ''; };
  const setBusy = value => {
    $('#import-analyze').disabled = value;
    $('#import-analyze').textContent = value ? '正在识别…' : '识别并预览';
    $('#import-fill-editor').disabled = value || !candidate;
    dialog.setAttribute('aria-busy', String(value));
  };
  function invalidate() {
    ++requestVersion;
    pending?.abort(); pending = null; candidate = null;
    $('#import-result').hidden = true;
    $('#import-status').textContent = '';
    error(''); setBusy(false);
  }
  function close() { invalidate(); dialog.close(); }
  function selectSource(value) {
    source = value; invalidate();
    for (const button of dialog.querySelectorAll('[data-import-source]')) {
      const selected = button.dataset.importSource === value;
      button.setAttribute('aria-pressed', String(selected));
    }
    $('#import-paste-panel').hidden = value !== 'paste';
    $('#import-file-panel').hidden = value !== 'file';
  }
  function open() {
    try {
      if (!window.piaEditor) throw new Error('正文编辑器尚未就绪，请稍后重试。');
      draft = window.piaEditor.getDraft();
      invalidate();
      $('#import-text').value = ''; $('#import-file').value = '';
      $('#import-mode-append').checked = true;
      const texts = draft.blocks.filter(block => block.kind !== 'image').length;
      const images = draft.blocks.filter(block => block.kind === 'image').length;
      $('#import-current-draft').textContent = `当前草稿有 ${texts} 个文字段落、${images} 张插图。追加保留现有内容；替换文字后，原插图保留在末尾。`;
      selectSource('paste'); dialog.showModal(); $('#import-text').focus();
    } catch (failure) {
      const target = document.querySelector('#script-error');
      if (target) target.textContent = failure.message;
    }
  }
  async function requestPreview(body, signal) {
    let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const multipart = body instanceof FormData;
      const response = await fetch('/api/import-preview', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: {'X-CSRF-Token': csrf, ...(multipart ? {} : {'Content-Type': 'application/json'})},
        body: multipart ? body : JSON.stringify(body)
      });
      let payload;
      try { payload = await response.json(); } catch { throw new Error('导入服务返回了无效响应，请重试。'); }
      if (response.ok) return payload;
      if (attempt === 0 && response.status === 403 && payload.code === 'csrf_failed') {
        const refresh = await fetch('/api/library', {credentials: 'same-origin', signal});
        if (refresh.ok) {
          csrf = (await refresh.json()).csrf_token || csrf;
          const meta = document.querySelector('meta[name="csrf-token"]'); if (meta) meta.content = csrf;
          continue;
        }
      }
      throw new Error(payload.error || '识别失败，请检查文件或文本后重试。');
    }
  }
  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text ?? ''; return element;
  }
  function render(result) {
    candidate = result.candidate;
    if (!candidate || !Array.isArray(candidate.blocks) || !candidate.blocks.length) throw new Error('未找到可导入的正文内容。');
    $('#import-preview-title').textContent = candidate.title || '未识别到标题';
    $('#import-preview-author').textContent = candidate.author ? `作者 / 来源：${candidate.author}` : '未识别到作者，可在编辑器补充。';
    $('#import-preview-meta').textContent = `${candidate.blocks.length} 个段落${result.filename ? ' · ' + result.filename : ''}${result.encoding ? ' · ' + result.encoding : ''}`;
    const roles = Array.isArray(result.roles) ? result.roles : [];
    $('#import-role-list').replaceChildren(...(roles.length ? roles.map(role => textElement('span', 'import-role-chip', role)) : [textElement('span', 'muted', '未识别到明确角色，可在段落编辑中填写。')]));
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    $('#import-warnings').replaceChildren(...warnings.map(message => textElement('li', '', message)));
    $('#import-warnings').hidden = warnings.length === 0;
    const blocks = candidate.blocks.map((block, index) => {
      const row = textElement('article', 'import-preview-block', '');
      const heading = textElement('div', 'import-preview-block-heading', `段落 ${index + 1}`);
      if (block.role) {
        const role = textElement('span', 'import-role-chip', block.role);
        if (/^#[a-fA-F0-9]{6}$/.test(block.color || '')) role.style.color = block.color;
        heading.append(role);
      }
      row.append(heading, textElement('pre', 'import-paragraph-text', block.text)); return row;
    });
    $('#import-preview-blocks').replaceChildren(...blocks);
    $('#import-source-text').textContent = candidate.source_text ?? candidate.blocks.map(block => block.text || '').join('');
    $('#import-result').hidden = false;
    $('#import-status').textContent = '识别完成。请核对原文和角色，确认后再填入编辑器。';
  }
  async function analyze() {
    invalidate();
    let body;
    if (source === 'paste') {
      const text = $('#import-text').value;
      if (!text.trim()) { error('请先粘贴需要导入的剧本正文。'); $('#import-text').focus(); return; }
      body = {text};
    } else {
      const file = $('#import-file').files[0];
      if (!file) { error('请先选择 TXT 或 DOCX 文件。'); return; }
      if (!/\.(txt|docx)$/i.test(file.name)) { error('仅支持 TXT 和 DOCX 文件。'); return; }
      body = new FormData(); body.append('file', file);
    }
    const version = requestVersion; pending = new AbortController(); setBusy(true);
    try {
      const result = await requestPreview(body, pending.signal);
      if (version !== requestVersion || !dialog.open) return;
      render(result);
    } catch (failure) {
      if (failure.name !== 'AbortError' && version === requestVersion) { candidate = null; error(failure.message); }
    } finally {
      if (version === requestVersion) { pending = null; setBusy(false); }
    }
  }
  async function fillEditor() {
    if (!candidate || !draft) return;
    $('#import-fill-editor').disabled = true; error('');
    try {
      await window.piaEditor.applyImport({candidate, mode: $('#import-mode-replace').checked ? 'replace' : 'append', session_id: draft.session_id});
      close();
      document.querySelector('#body-editor-details').open = true;
      const status = document.querySelector('#import-editor-status');
      if (status) status.textContent = '识别内容已填入草稿。可继续修改，点击“保存剧本”后才会入库。';
    } catch (failure) { error(failure.message || '填入失败，请重新打开导入窗口。'); setBusy(false); }
  }
  $('#copy-import-ai-prompt')?.addEventListener('click', async () => {
    const field = $('#import-ai-prompt'), status = $('#import-ai-copy-status');
    field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(field.value);
      status.textContent = '已复制。粘贴到常用 AI 后，再附上剧本原文。';
    } catch (_) {
      let copied = false;
      try { field.focus(); field.select(); copied = document.execCommand('copy'); } catch (_) { /* selected text remains the final fallback */ }
      status.textContent = copied ? '已复制。粘贴到常用 AI 后，再附上剧本原文。' : '提示词已选中，请按 Ctrl+C 复制，也可右键选择复制。';
    }
  });
  document.querySelector('#open-import-editor')?.addEventListener('click', open);
  for (const button of dialog.querySelectorAll('[data-import-source]')) button.addEventListener('click', () => selectSource(button.dataset.importSource));
  for (const button of dialog.querySelectorAll('[data-import-close]')) button.addEventListener('click', close);
  $('#import-text').addEventListener('input', invalidate); $('#import-file').addEventListener('change', invalidate);
  $('#import-analyze').addEventListener('click', analyze);
  $('#import-fill-editor').addEventListener('click', fillEditor);
  dialog.addEventListener('cancel', invalidate); dialog.addEventListener('close', invalidate);
})();
