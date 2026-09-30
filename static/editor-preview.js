(() => {
  'use strict';
  const dialog = document.getElementById('script-dialog');
  const form = document.getElementById('script-form');
  if (!dialog || !form) return;
  const heading = form.querySelector(':scope > .dialog-heading');
  const actions = form.querySelector(':scope > .dialog-actions');
  const editPane = document.createElement('div');
  editPane.className = 'editor-edit-pane';
  editPane.setAttribute('aria-label', '剧本编辑区域');
  for (const child of [...form.children]) {
    if (child !== heading && child !== actions) editPane.appendChild(child);
  }
  form.insertBefore(editPane, actions);
  const panel = document.createElement('details');
  panel.id = 'editor-preview-panel';
  panel.className = 'editor-preview-panel';
  panel.innerHTML = `<summary>排版预览 <span class="help">查看未保存草稿</span></summary>
    <div class="editor-preview-controls">
      <label>画幅<select id="editor-preview-orientation"><option value="portrait">竖屏</option><option value="landscape">横屏</option></select></label>
      <label>正文方式<select id="editor-preview-mode"><option value="pages">分页</option><option value="scroll">连续滚动</option></select></label>
      <button type="button" class="button secondary small" id="editor-preview-refresh">刷新预览</button>
      <button type="button" class="button secondary small" id="editor-preview-zoom" aria-pressed="false">放大预览</button>
    </div>
    <p class="help editor-preview-help">选中编辑段落会定位预览，点击预览台词可返回编辑。整页适配当前窗口；预览不保存资料，也不上屏。</p>
    <p id="editor-preview-status" class="editor-preview-status" role="status">展开后加载预览。</p>
    <div class="editor-preview-stage-slot"><div class="editor-preview-viewport"><iframe id="editor-preview-frame" title="剧本草稿排版预览"></iframe></div></div>
    <div class="editor-preview-navigation"><button type="button" class="button secondary small" id="editor-preview-previous" disabled>上一页</button><span id="editor-preview-page">尚未预览</span><button type="button" class="button secondary small" id="editor-preview-next" disabled>下一页</button></div>`;
  form.insertBefore(panel, actions);
  const $ = id => document.getElementById(id);
  const frame = $('editor-preview-frame');
  const orientation = $('editor-preview-orientation');
  const mode = $('editor-preview-mode');
  const status = $('editor-preview-status');
  const stageSlot = panel.querySelector('.editor-preview-stage-slot');
  const viewport = panel.querySelector('.editor-preview-viewport');
  let editor = null, snapshot = null, ready = false, rendered = false, pending = false;
  let version = 0, timer = 0, controller = null, pageIndex = 0, selectedAnchor = null;
  let tools = {}, snapshotVersion = -1;
  let suppressEditorFocus = false, fitTimer = 0;
  const send = data => { if (ready && frame.contentWindow) frame.contentWindow.postMessage(data, location.origin); };
  function fitPage() {
    if (!panel.open || !dialog.open) return;
    const width = stageSlot.clientWidth, height = stageSlot.clientHeight;
    if (width < 1 || height < 1) return;
    const ratio = orientation.value === 'landscape' ? 16 / 9 : 9 / 16;
    // Explicit pixel sizes fit both dimensions, instead of letting a wide
    // portrait canvas grow taller than the visible dialog.
    const pageWidth = Math.max(1, Math.min(width, height * ratio));
    const pageHeight = pageWidth / ratio;
    viewport.style.width = pageWidth + 'px';
    viewport.style.height = pageHeight + 'px';
  }
  const sizeObserver = new ResizeObserver(fitPage);
  sizeObserver.observe(stageSlot);
  function highlightLinked() {
    for (const row of editPane.querySelectorAll('.body-editor-row')) {
      row.classList.toggle('editor-linked-block', row.dataset.blockId === selectedAnchor);
    }
  }
  function focusPreview() {
    if (!selectedAnchor || !rendered || pending || !snapshot || snapshotVersion !== version) return;
    if (!snapshot.scripts.some(script => script.blocks.some(block => block.id === selectedAnchor))) return;
    send({type: 'pia-editor-focus', snapshot_id: snapshot.id, anchor: selectedAnchor});
  }
  function selectEditorBlock(anchor) {
    selectedAnchor = anchor;
    highlightLinked();
    focusPreview();
  }
  function controls() {
    const enabled = panel.open && dialog.open && rendered && snapshot && !pending && !editor?.isBusy?.();
    $('editor-preview-previous').disabled = !enabled || (mode.value === 'pages' && !(tools.page_index > 0));
    $('editor-preview-next').disabled = !enabled || (mode.value === 'pages' && !(tools.page_index + 1 < tools.page_count));
    $('editor-preview-refresh').disabled = !!editor?.isBusy?.();
    $('editor-preview-previous').textContent = mode.value === 'pages' ? '上一页' : '上一段';
    $('editor-preview-next').textContent = mode.value === 'pages' ? '下一页' : '下一段';
    $('editor-preview-page').textContent = mode.value === 'pages' && tools.page_count ? `${tools.page_index + 1} / ${tools.page_count} 页` : rendered ? '点击台词可定位编辑' : '尚未预览';
  }
  function setZoom(enabled) {
    dialog.classList.toggle('editor-preview-focus', enabled && panel.open);
    $('editor-preview-zoom').setAttribute('aria-pressed', String(enabled && panel.open));
    $('editor-preview-zoom').textContent = enabled && panel.open ? '恢复编辑' : '放大预览';
    fitPage();
  }
  function invalidate() {
    ++version; clearTimeout(timer); controller?.abort(); controller = null;
    pending = false; rendered = false; controls();
  }
  function showSnapshot() {
    if (!snapshot || snapshotVersion !== version || !ready || !panel.open || !dialog.open) return;
    send({type: 'pia-preview-options', placement: 'outside', feedback: 'confirm'});
    send({type: 'pia-preview-live-binding', enabled: false});
    send({type: 'pia-preview', snapshot, anchor: selectedAnchor, page_index: pageIndex});
    send({type: 'pia-preview-status', snapshot_id: snapshot.id, can_apply: false, message: '编辑草稿 · 仅预览'});
  }
  async function refresh() {
    if (!editor || !dialog.open || !panel.open) return;
    if (editor.isBusy?.()) { status.textContent = '请等图片上传或保存完成后再预览。'; controls(); return; }
    let draft;
    try { draft = editor.getFullDraft(); } catch (_) { return; }
    const ticket = ++version;
    controller?.abort(); controller = new AbortController();
    pending = true; rendered = false; status.textContent = '正在按当前草稿排版…'; controls();
    try {
      const response = await fetch('/api/editor-preview', {method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''},
        body: JSON.stringify({script_id: draft.script_id || null, draft, orientation: orientation.value, body_mode: mode.value})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '草稿预览未完成，请重试。');
      if (ticket !== version || !dialog.open || !panel.open) return;
      snapshot = result.snapshot; snapshotVersion = ticket;
      if (!snapshot?.id || !Array.isArray(snapshot.scripts)) throw new Error('预览资料格式无效。');
      if (!snapshot.scripts.some(s => s.blocks.some(b => b.id === selectedAnchor))) selectedAnchor = null;
      highlightLinked();
      status.textContent = '正在呈现排版…'; showSnapshot();
    } catch (error) {
      if (ticket === version && error.name !== 'AbortError') status.textContent = '预览未更新：' + error.message;
    } finally { if (ticket === version) { pending = false; controls(); } }
  }
  function schedule() {
    invalidate();
    if (!panel.open || !dialog.open) return;
    status.textContent = '草稿已变化，正在更新预览…'; timer = setTimeout(refresh, 550);
  }
  function attachEditor(api) {
    if (editor || !api?.getFullDraft || !api?.subscribe) return false;
    editor = api;
    editor.subscribe(event => {
      if (event.type === 'close') { invalidate(); setZoom(false); snapshot = null; tools = {}; pageIndex = 0; selectedAnchor = null; highlightLinked(); return; }
      if (event.type === 'open') { pageIndex = 0; selectedAnchor = null; tools = {}; editPane.scrollTop = 0; dialog.scrollTop = 0; fitPage(); }
      if (event.type === 'saved') { invalidate(); return; }
      if (event.type === 'busy') { controls(); return; }
      highlightLinked();
      schedule();
    });
    return true;
  }
  if (!attachEditor(window.piaEditor)) {
    const probe = setInterval(() => { if (attachEditor(window.piaEditor)) clearInterval(probe); }, 100);
    window.addEventListener('pagehide', () => clearInterval(probe), {once: true});
  }
  panel.addEventListener('toggle', () => {
    dialog.classList.toggle('editor-preview-open', panel.open);
    if (!panel.open) { invalidate(); setZoom(false); return; }
    dialog.scrollTop = 0;
    fitPage();
    if (!frame.getAttribute('src')) frame.src = '/display?preview=1&editor=1';
    void refresh();
  });
  frame.addEventListener('load', () => {
    try {
      frame.contentDocument.addEventListener('click', event => {
        const anchor = event.target.closest?.('[data-anchor]')?.dataset.anchor;
        if (!anchor || !snapshot || snapshotVersion !== version || !snapshot.scripts.some(s => s.blocks.some(b => b.id === anchor))) return;
        selectedAnchor = anchor; setZoom(false); highlightLinked();
        // Focusing the editor in response to a preview click is the other
        // direction of the link; it must not bounce back into the iframe.
        suppressEditorFocus = true;
        try { editor?.focusBlock(anchor); } finally { suppressEditorFocus = false; }
        focusPreview();
      });
    } catch (_) { status.textContent = '预览应与工作台使用相同地址。'; }
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data?.type === 'pia-preview-ready') { ready = true; showSnapshot(); return; }
    if (!snapshot || snapshotVersion !== version || data?.snapshot_id !== snapshot.id) return;
    if (data.type === 'pia-preview-exit-focus') { setZoom(false); return; }
    if (data.type === 'pia-preview-rendered') { rendered = true; status.textContent = '已更新到当前草稿 · 未保存 / 未上屏'; controls(); fitPage(); focusPreview(); }
    if (data.type === 'pia-editor-focused') {
      if (data.anchor !== selectedAnchor) return;
      tools = {...tools, ...data};
      if (Number.isInteger(data.page_index)) pageIndex = data.page_index;
      controls();
      return;
    }
    if (data.type === 'pia-preview-tools' || data.type === 'pia-preview-position') {
      tools = {...tools, ...data}; if (Number.isInteger(data.page_index)) pageIndex = data.page_index; controls();
    }
    // Editing previews intentionally have no handler for apply/font/live actions.
  });
  editPane.addEventListener('focusin', event => {
    if (suppressEditorFocus) return;
    const row = event.target.closest?.('.body-editor-row[data-block-id]');
    if (row) selectEditorBlock(row.dataset.blockId);
  });
  orientation.addEventListener('change', () => { dialog.classList.toggle('editor-preview-landscape', orientation.value === 'landscape'); pageIndex = 0; fitPage(); void refresh(); });
  mode.addEventListener('change', () => { pageIndex = 0; void refresh(); });
  $('editor-preview-refresh').addEventListener('click', () => { clearTimeout(timer); void refresh(); });
  $('editor-preview-zoom').addEventListener('click', () => setZoom(!dialog.classList.contains('editor-preview-focus')));
  for (const [id, direction] of [['editor-preview-previous', -1], ['editor-preview-next', 1]]) $(id).addEventListener('click', () => {
    send({type: 'pia-preview-command', snapshot_id: snapshot?.id, action: mode.value === 'pages' ? direction < 0 ? 'previous-page' : 'next-page' : direction < 0 ? 'previous' : 'next'});
  });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && dialog.classList.contains('editor-preview-focus')) { event.preventDefault(); event.stopPropagation(); setZoom(false); } });
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitPage, 50); });
  window.addEventListener('pagehide', () => { invalidate(); clearTimeout(fitTimer); sizeObserver.disconnect(); });
})();
