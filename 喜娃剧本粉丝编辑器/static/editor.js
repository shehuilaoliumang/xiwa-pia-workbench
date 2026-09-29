/* 喜娃剧本粉丝编辑器 — 页面逻辑（含音视频配本编辑，与管理系统的编辑能力对齐） */
"use strict";

const CSRF = document.querySelector('meta[name="csrf"]').content;
const PALETTE = ['#343b37', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#d35400', '#e84393', '#34495e', '#7f8c8d'];
const DEFAULT_COLOR = '#343b37';
const KIND_TEXT = { mp4: '视频（MP4）', webm: '视频（WebM）', mp3: '音频（MP3）', wav: '音频（WAV）', m4a: '音频（M4A）', ogg: '音频（OGG）' };

let currentId = null;
let script = null;
let blocks = [];

function toast(message, isError) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.className = 'toast', 3600);
}

async function api(path, options) {
  options = options || {};
  const headers = {};
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = CSRF;
  if (options.json) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: options.method || 'GET', headers, body: options.json ? JSON.stringify(options.json) : options.body });
  if (!res.ok) {
    let message = '请求失败（' + res.status + '）';
    try { const data = await res.json(); if (data && data.error) message = data.error; } catch (e) {}
    throw new Error(message);
  }
  return res;
}

function fmtSize(size) {
  if (size == null) return '-';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '-';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtStamp(sec) {
  if (sec == null || isNaN(sec)) return '00:00.000';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return m + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}

/* 接受 "83.5" 或 "01:23.500"；失败返回 null */
function parseCueTime(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (value.indexOf(':') >= 0) {
    const parts = value.split(':');
    if (parts.length !== 2) return null;
    const m = Number(parts[0]), s = Number(parts[1]);
    if (!isFinite(m) || !isFinite(s) || m < 0 || s < 0) return null;
    return m * 60 + s;
  }
  const seconds = Number(value);
  if (!isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

function uid(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function assetUrl(ref) {
  if (!ref) return '';
  const name = ref.split('/').pop();
  return '/api/workspaces/' + currentId + '/assets/' + encodeURIComponent(name);
}

function stopPlayer() {
  const player = document.getElementById('mediaPlayer');
  if (player && player.pause) { player.pause(); }
}

async function refreshList(selectId) {
  const data = await (await api('/api/workspaces')).json();
  const list = document.getElementById('wsList');
  list.innerHTML = '';
  document.getElementById('wsEmpty').hidden = data.workspaces.length > 0;
  for (const ws of data.workspaces) {
    const card = document.createElement('div');
    card.className = 'ws-card' + (ws.id === selectId ? ' active' : '');
    const meta = [
      ws.category_name ? '原分类：' + ws.category_name : '',
      ws.text_blocks + ' 文字段 / ' + ws.image_blocks + ' 插图',
      ws.has_media ? '含音视频 · ' + ws.cue_count + ' 个时间点' : '无音视频'
    ].filter(Boolean).join(' · ');
    card.innerHTML = '<div class="t"></div><div class="m"></div><div class="ops">' +
      '<button class="btn plain small" data-act="open">编辑</button>' +
      '<button class="btn danger small" data-act="del">删除</button></div>';
    card.querySelector('.t').textContent = ws.title || '未命名';
    card.querySelector('.m').textContent = meta;
    card.addEventListener('click', e => {
      const act = e.target.closest('button');
      if (!act) { openWorkspace(ws.id); return; }
      if (act.dataset.act === 'open') openWorkspace(ws.id);
      if (act.dataset.act === 'del') deleteWorkspace(ws.id);
    });
    list.appendChild(card);
  }
}

async function openWorkspace(id) {
  try {
    stopPlayer();
    const data = await (await api('/api/workspaces/' + id)).json();
    currentId = id;
    script = data.script;
    blocks = JSON.parse(JSON.stringify(script.blocks || []));
    document.getElementById('fTitle').value = script.title || '';
    document.getElementById('fAuthor').value = script.author || '';
    document.getElementById('fTags').value = (script.tags || []).join('，');
    document.getElementById('fSynopsis').value = script.synopsis || '';
    document.getElementById('fCastNote').value = script.cast_note || '';
    document.getElementById('fNotes').value = script.notes || '';
    document.getElementById('fVisible').checked = script.visible !== false;
    renderBlocks();
    renderMedia();
    document.getElementById('editorTitle').textContent = (script.title || '未命名') + '　·　编辑中';
    document.getElementById('editorPanel').hidden = false;
    document.getElementById('welcome').hidden = true;
    await refreshList(id);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderBlocks() {
  const wrap = document.getElementById('blocks');
  wrap.innerHTML = '';
  blocks.forEach((block, index) => {
    const card = document.createElement('div');
    card.className = 'block';
    if (block.kind === 'image') {
      const src = assetUrl(block.image_path);
      card.innerHTML = '<div class="imgwrap"><img src="' + src + '" alt="插图">' +
        '<div class="ops"><button class="btn plain small" data-op="replace">替换图片</button>' +
        '<button class="btn plain small" data-op="up">↑</button>' +
        '<button class="btn plain small" data-op="down">↓</button>' +
        '<button class="btn danger small" data-op="del">删除</button></div></div>' +
        '<input type="file" accept=".png,.jpg,.jpeg,.webp" class="imgfile" hidden>';
      card.querySelector('[data-op=replace]').addEventListener('click', () => card.querySelector('.imgfile').click());
      card.querySelector('.imgfile').addEventListener('change', e => replaceImage(index, e.target.files[0]));
    } else {
      const original = block.original_text && block.original_text !== block.text ? block.original_text : '';
      card.innerHTML =
        '<div class="row"><div class="role"><input class="roleInput" placeholder="角色名，如：旁白 / 小明" value="">' +
        '<div class="colorline" style="margin-top:6px">角色颜色 <input type="color" class="colorInput" value="' + DEFAULT_COLOR + '"></div></div>' +
        '</div>' +
        (original ? '<div class="muted">原稿：' + esc(original) + '</div>' : '') +
        '<textarea class="textInput" placeholder="台词内容……"></textarea>' +
        '<div class="ops"><button class="btn plain small" data-op="up">↑</button>' +
        '<button class="btn plain small" data-op="down">↓</button>' +
        '<button class="btn danger small" data-op="del">删除</button></div>';
      card.querySelector('.roleInput').value = block.role || '';
      const currentColor = /^#[0-9a-f]{6}$/i.test(block.color) ? block.color : DEFAULT_COLOR;
      card.querySelector('.colorInput').value = currentColor;
      card.querySelector('.textInput').value = block.text || '';
      card.querySelector('.textInput').addEventListener('input', () => { delete block.runs; });
    }
    card.querySelectorAll('[data-op=up],[data-op=down],[data-op=del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const op = btn.dataset.op;
        if (op === 'up' && index > 0) { [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]]; renderBlocks(); }
        if (op === 'down' && index < blocks.length - 1) { [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]]; renderBlocks(); }
        if (op === 'del') {
          const used = (script.media && script.media.cues || []).some(cue => (cue.block_ids || []).includes(block.id));
          const note = used ? '该段被音视频时间点引用，需先在「音视频配本」中调整或删除相关时间点，才能删除此段（与主播管理系统规则一致）。' : '';
          if (confirm('确定删除这个段落吗？' + (note ? '\n' + note : ''))) {
            blocks.splice(index, 1);
            renderBlocks();
          }
        }
      });
    });
    wrap.appendChild(card);
  });
}

function collect() {
  if (!script) return null;
  const tags = document.getElementById('fTags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  return {
    title: document.getElementById('fTitle').value.trim(),
    author: document.getElementById('fAuthor').value.trim(),
    synopsis: document.getElementById('fSynopsis').value,
    cast_note: document.getElementById('fCastNote').value,
    notes: document.getElementById('fNotes').value,
    tags: tags,
    visible: document.getElementById('fVisible').checked,
    blocks: blocks.map((block, index) => {
      const card = document.getElementById('blocks').children[index];
      const copy = { ...block };
      if (block.kind === 'text' && card) {
        copy.role = card.querySelector('.roleInput').value.trim();
        copy.color = card.querySelector('.colorInput').value;
        const text = card.querySelector('.textInput').value;
        if (text !== block.text) delete copy.runs;
        copy.text = text;
      }
      return copy;
    })
  };
}

async function save() {
  if (!currentId) return;
  const payload = collect();
  if (!payload.title) { toast('剧名不能为空。', true); return; }
  try {
    const res = await api('/api/workspaces/' + currentId, { method: 'PUT', json: payload });
    const data = await res.json();
    script = data.script;
    toast('已保存。');
    await refreshList(currentId);
  } catch (error) {
    toast(error.message, true);
  }
}

async function exportZip() {
  if (!currentId) return;
  try {
    const res = await api('/api/workspaces/' + currentId + '/export', { method: 'POST' });
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/) || disposition.match(/filename="?([^";]+)"?/);
    const filename = match ? decodeURIComponent(match[1]) : '喜娃剧本-' + (script.title || '未命名') + '.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出：' + filename + '　（可直接发给主播导入）');
  } catch (error) {
    toast(error.message, true);
  }
}

async function importPackage(file) {
  if (!file) return;
  if (file.size > 550 * 1024 * 1024) { toast('剧本包过大（超过 512 MB）。', true); return; }
  try {
    const body = new FormData();
    body.append('package', file);
    const res = await fetch('/api/workspaces', { method: 'POST', headers: { 'X-CSRF-Token': CSRF }, body });
    if (!res.ok) {
      let message = '导入失败（' + res.status + '）';
      try { const data = await res.json(); if (data.error) message = data.error; } catch (e) {}
      throw new Error(message);
    }
    const data = await res.json();
    toast('导入成功，开始编辑《' + (data.workspace.title || '未命名') + '》。');
    openWorkspace(data.workspace.id);
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteWorkspace(id) {
  if (!confirm('确定删除这个本地剧本工作区吗？\n删除后如需修改请重新导入主播发的 ZIP。')) return;
  try {
    await api('/api/workspaces/' + id, { method: 'DELETE' });
    if (currentId === id) {
      stopPlayer();
      currentId = null; script = null; blocks = [];
      document.getElementById('editorPanel').hidden = true;
      document.getElementById('welcome').hidden = false;
    }
    toast('已删除。');
    refreshList(null);
  } catch (error) {
    toast(error.message, true);
  }
}

async function uploadImage(file, onRef) {
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { toast('插图须在 12 MB 以内。', true); return; }
  try {
    const body = new FormData();
    body.append('image', file);
    const res = await fetch('/api/workspaces/' + currentId + '/images', { method: 'POST', headers: { 'X-CSRF-Token': CSRF }, body });
    if (!res.ok) {
      let message = '图片上传失败（' + res.status + '）';
      try { const data = await res.json(); if (data.error) message = data.error; } catch (e) {}
      throw new Error(message);
    }
    const data = await res.json();
    onRef(data.ref);
    toast('插图已添加，记得保存。');
  } catch (error) {
    toast(error.message, true);
  }
}

function addTextBlock() {
  blocks.push({ id: uid('block-'), kind: 'text', text: '', role: '', color: DEFAULT_COLOR });
  renderBlocks();
}

function addImageBlock(file) {
  uploadImage(file, ref => {
    blocks.push({ id: uid('block-'), kind: 'image', text: '', image_path: ref });
    renderBlocks();
  });
}

function replaceImage(index, file) {
  uploadImage(file, ref => {
    blocks[index].image_path = ref;
    renderBlocks();
  });
}

/* ---------------- 新建剧本（从 0 到 1） ---------------- */

let pendingPreview = null;   // 解析后的候选：{candidate:{title,author,blocks}, roles, warnings}

function openNewModal() {
  pendingPreview = null;
  document.getElementById('nTitle').value = '';
  document.getElementById('nAuthor').value = '';
  document.getElementById('nCategory').value = '';
  document.getElementById('nText').value = '';
  document.getElementById('nParseStatus').textContent = '';
  document.getElementById('nPreview').hidden = true;
  document.getElementById('newMask').hidden = false;
}

function closeNewModal() {
  document.getElementById('newMask').hidden = true;
  pendingPreview = null;
}

async function parsePreviewText(text) {
  const status = document.getElementById('nParseStatus');
  status.textContent = '解析中……';
  try {
    const res = await api('/api/import-preview', { method: 'POST', json: { text: text, filename: '粘贴文本' } });
    showPreview(await res.json());
    status.textContent = '';
  } catch (error) {
    status.textContent = '';
    toast(error.message, true);
  }
}

async function parsePreviewFile(file) {
  if (!file) return;
  if (file.size > 11 * 1024 * 1024) { toast('TXT 须在 2 MB 以内，DOCX 须在 10 MB 以内。', true); return; }
  const status = document.getElementById('nParseStatus');
  status.textContent = '解析中……';
  try {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/import-preview', { method: 'POST', headers: { 'X-CSRF-Token': CSRF }, body });
    if (!res.ok) {
      let message = '解析失败（' + res.status + '）';
      try { const data = await res.json(); if (data.error) message = data.error; } catch (e) {}
      throw new Error(message);
    }
    showPreview(await res.json());
    status.textContent = '';
  } catch (error) {
    status.textContent = '';
    toast(error.message, true);
  }
}

function showPreview(data) {
  pendingPreview = data;
  const candidate = data.candidate || {};
  const blocks = candidate.blocks || [];
  document.getElementById('nTitle').value = document.getElementById('nTitle').value || candidate.title || '';
  document.getElementById('nAuthor').value = document.getElementById('nAuthor').value || candidate.author || '';
  document.getElementById('pvTitle').textContent = candidate.title || '未命名';
  document.getElementById('pvAuthor').textContent = candidate.author || '（未识别）';
  document.getElementById('pvBlocks').textContent = blocks.length;
  document.getElementById('pvRoles').textContent = (data.roles && data.roles.length) ? data.roles.join('、') : '（未识别）';
  const warnings = document.getElementById('pvWarnings');
  warnings.innerHTML = '';
  (data.warnings || []).forEach(w => {
    const line = document.createElement('div');
    line.className = 'pv-warn';
    line.textContent = '· ' + w;
    warnings.appendChild(line);
  });
  const body = document.getElementById('pvBody');
  body.innerHTML = '';
  blocks.slice(0, 12).forEach(block => {
    const line = document.createElement('div');
    line.className = 'pv-block';
    line.textContent = (block.role ? block.role + '：' : '') + block.text;
    body.appendChild(line);
  });
  if (blocks.length > 12) {
    const more = document.createElement('div');
    more.className = 'pv-more';
    more.textContent = '……（其余 ' + (blocks.length - 12) + ' 段将一并创建，可在编辑器里继续调整）';
    body.appendChild(more);
  }
  document.getElementById('nPreview').hidden = false;
}

function collectNewPayload() {
  const title = document.getElementById('nTitle').value.trim();
  const author = document.getElementById('nAuthor').value.trim();
  const category = document.getElementById('nCategory').value.trim();
  // 有解析结果用解析段落；未解析则创建空白剧本（blocks 为空，稍后在编辑器里添加）。
  const candidate = pendingPreview ? pendingPreview.candidate : null;
  const blocks = (candidate && candidate.blocks) || [];
  return { title: title || (candidate ? candidate.title : '') || '未命名剧本', author: author,
           category_name: category, blocks: blocks, synopsis: '', cast_note: '', notes: '', tags: [], visible: true };
}

async function createNew() {
  const payload = collectNewPayload();
  try {
    const res = await api('/api/workspaces/new', { method: 'POST', json: payload });
    const data = await res.json();
    closeNewModal();
    toast('已创建《' + (data.workspace.title || '未命名') + '》，开始编辑。');
    await openWorkspace(data.workspace.id);
  } catch (error) {
    toast(error.message, true);
  }
}

document.getElementById('btnNew').addEventListener('click', openNewModal);
document.getElementById('btnNewCancel').addEventListener('click', closeNewModal);
document.getElementById('btnWelcomeNew').addEventListener('click', openNewModal);
document.getElementById('btnWelcomeImport').addEventListener('click', () => document.getElementById('filePackage').click());

/* 最左侧剧本列表：可折叠，状态记忆（默认显示） */
(function bindListToggle() {
  const btn = document.getElementById('btnToggleList');
  const apply = () => btn.textContent = document.body.classList.contains('hide-list') ? '📋 显示剧本列表' : '📋 隐藏剧本列表';
  if (localStorage.getItem('fan.hideList') === '1') document.body.classList.add('hide-list');
  apply();
  btn.addEventListener('click', () => {
    document.body.classList.toggle('hide-list');
    try { localStorage.setItem('fan.hideList', document.body.classList.contains('hide-list') ? '1' : '0'); } catch (e) {}
    apply();
  });
})();
document.getElementById('btnParse').addEventListener('click', () => {
  const text = document.getElementById('nText').value;
  if (!text.trim()) { toast('请先粘贴正文或选择 TXT / DOCX 文件。', true); return; }
  parsePreviewText(text);
});
document.getElementById('btnPickTextFile').addEventListener('click', () => document.getElementById('fileTextImport').click());
document.getElementById('fileTextImport').addEventListener('change', e => { parsePreviewFile(e.target.files[0]); e.target.value = ''; });
document.getElementById('btnCreate').addEventListener('click', createNew);
document.getElementById('newMask').addEventListener('click', e => { if (e.target.id === 'newMask') closeNewModal(); });

/* ---------------- 音视频配本 ---------------- */

function mediaKindText(media) {
  const ext = (media.path || '').split('.').pop().toLowerCase();
  return KIND_TEXT[ext] || media.kind || '音视频';
}

function renderMedia() {
  const media = script && script.media;
  document.getElementById('mediaEmpty').hidden = Boolean(media);
  document.getElementById('mediaPresent').hidden = !media;
  document.getElementById('cueEditList').innerHTML = '';
  document.getElementById('cueSaveState').textContent = '';
  const tag = document.getElementById('mediaStatusTag');
  if (tag) {
    if (media) { tag.textContent = '已关联 · ' + mediaKindText(media); tag.classList.add('linked'); }
    else { tag.textContent = '尚未关联'; tag.classList.remove('linked'); }
  }
  if (!media) return;
  document.getElementById('mediaName').textContent = media.name || '';
  document.getElementById('mediaMeta').textContent = '　' + mediaKindText(media) + ' · ' + fmtSize(media.size);
  const savedDuration = media.duration;
  document.getElementById('mediaDurationHint').textContent = savedDuration ? '已保存时长 ' + fmtDuration(savedDuration) : '时长将在载入播放器后显示';
  renderCueList();
}

function renderCueList() {
  const media = script.media;
  const list = document.getElementById('cueEditList');
  list.innerHTML = '';
  (media.cues || []).forEach(cue => list.appendChild(buildCueRow(cue)));
  document.getElementById('cueCount').textContent = (media.cues || []).length + ' 个';
}

function buildCueRow(cue) {
  const row = document.createElement('li');
  row.className = 'cue-row';
  row.innerHTML =
    '<div class="line1">' +
    '<input class="cueAt" placeholder="秒数或 分:秒" value="' + esc(cue.at) + '">' +
    '<input class="cueLabel" placeholder="时间点名称（可选）" value="' + esc(cue.label || '') + '">' +
    '<span class="badge">关联 <b class="cueBadgeCount">' + (cue.block_ids || []).length + '</b> 段</span>' +
    '<button class="btn plain small cueToggle">选择台词</button>' +
    '<button class="btn danger small cueDel">删除</button>' +
    '</div>' +
    '<div class="cue-blocks" hidden><input class="cue-search" placeholder="查找台词（按角色或正文）">' +
    '<div class="cue-choices"></div></div>';
  row.querySelector('.cueAt').value = Number.isFinite(cue.at) ? fmtStamp(cue.at) : String(cue.at || '');
  const choices = row.querySelector('.cue-choices');
  renderCueChoices(choices, cue.block_ids || [], row);
  row.querySelector('.cueToggle').addEventListener('click', () => {
    const panel = row.querySelector('.cue-blocks');
    panel.hidden = !panel.hidden;
  });
  row.querySelector('.cue-search').addEventListener('input', e => renderCueChoices(choices, cue.block_ids || [], row, e.target.value));
  row.querySelector('.cueDel').addEventListener('click', () => {
    media.cues = media.cues.filter(item => item.id !== cue.id);
    renderCueList();
    markCuesDirty();
  });
  return row;
}

function renderCueChoices(container, selectedIds, row, query) {
  container.innerHTML = '';
  const keyword = String(query || '').trim().toLowerCase();
  blocks.forEach(block => {
    const preview = block.kind === 'image' ? '[插图]' : ((block.role ? block.role + '：' : '') + (block.text || ''));
    if (keyword && preview.toLowerCase().indexOf(keyword) < 0) return;
    const line = document.createElement('label');
    line.className = 'choice-line';
    const checked = selectedIds.includes(block.id) ? ' checked' : '';
    line.innerHTML = '<input type="checkbox" data-block-id="' + esc(block.id) + '"' + checked + '>' +
      '<span class="' + (block.kind === 'image' ? 'img-tag' : 'role-tag') + '">' +
      (block.kind === 'image' ? '插图' : esc(block.role || '未命名')) + '</span>' +
      '<span class="preview">' + esc(preview) + '</span>';
    line.querySelector('input').addEventListener('change', () => {
      const badge = row.querySelector('.cueBadgeCount');
      const ids = Array.from(container.querySelectorAll('input:checked')).map(input => input.dataset.blockId);
      badge.textContent = ids.length;
      markCuesDirty();
    });
    container.appendChild(line);
  });
}

function markCuesDirty() {
  document.getElementById('cueSaveState').textContent = '有未保存的时间点修改。';
}

function mediaPlayerKind(media) {
  return media.kind === 'video' ? 'video' : 'audio';
}

function loadPlayer() {
  const media = script.media;
  if (!media) return;
  const wrap = document.getElementById('mediaPlayerWrap');
  const kind = mediaPlayerKind(media);
  let player = document.getElementById('mediaPlayer');
  if (!player || player.tagName.toLowerCase() !== (kind === 'video' ? 'video' : 'audio')) {
    const created = document.createElement(kind === 'video' ? 'video' : 'audio');
    created.id = 'mediaPlayer';
    created.controls = true;
    created.preload = 'metadata';
    wrap.innerHTML = '';
    wrap.appendChild(created);
    player = created;
  }
  player.src = assetUrl(media.path);
  player.onseeked = null;
  player.ontimeupdate = () => {
    document.getElementById('mediaCurrent').textContent = fmtStamp(player.currentTime);
  };
  player.onloadedmetadata = () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {
      document.getElementById('mediaDuration').textContent = fmtStamp(player.duration);
      media.duration = player.duration;
      document.getElementById('mediaDurationHint').textContent = '时长 ' + fmtDuration(player.duration);
    }
  };
}

function collectCuesFromRows() {
  const media = script.media;
  const rows = Array.from(document.querySelectorAll('#cueEditList .cue-row'));
  const cues = rows.map((row, index) => {
    const at = parseCueTime(row.querySelector('.cueAt').value);
    if (at == null) throw new Error('第 ' + (index + 1) + ' 个时间点的时间格式无效，请输入秒数或 分:秒（如 83.5 / 01:23.500）。');
    const label = row.querySelector('.cueLabel').value.trim();
    const blockIds = Array.from(row.querySelectorAll('.cue-choices input:checked')).map(input => input.dataset.blockId);
    return { id: (media.cues[index] || {}).id || uid('cue-'), at: at, label: label, block_ids: blockIds };
  });
  const atList = cues.map(cue => cue.at);
  if (new Set(atList).size !== atList.length) throw new Error('同一时间点请多选台词，不要创建重复秒数的时间点。');
  const empty = cues.find(cue => !cue.block_ids.length);
  if (empty) throw new Error('每个时间点须选择对应的台词段落（勾选“选择台词”）。');
  return cues;
}

async function saveCues() {
  const media = script && script.media;
  if (!media) return;
  try {
    const cues = collectCuesFromRows();
    const duration = (Number.isFinite(media.duration) && media.duration > 0) ? media.duration : null;
    const res = await api('/api/workspaces/' + currentId + '/media', { method: 'PUT', json: { duration: duration, cues: cues } });
    const data = await res.json();
    script.media = data.media;
    document.getElementById('cueSaveState').textContent = '时间点已保存。';
    toast('配本已保存。');
    renderMedia();
    await refreshList(currentId);
  } catch (error) {
    toast(error.message, true);
  }
}

async function uploadMedia(file) {
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) { toast('音视频须在 200 MB 以内。', true); return; }
  const status = document.getElementById('mediaUploadStatus');
  status.textContent = '正在上传……';
  try {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/workspaces/' + currentId + '/media', { method: 'POST', headers: { 'X-CSRF-Token': CSRF }, body });
    if (!res.ok) {
      let message = '媒体上传失败（' + res.status + '）';
      try { const data = await res.json(); if (data.error) message = data.error; } catch (e) {}
      throw new Error(message);
    }
    const data = await res.json();
    script.media = data.media;
    status.textContent = '';
    toast('音视频已关联，载入播放器后可标记时间点。');
    renderMedia();
    loadPlayer();
  } catch (error) {
    status.textContent = '';
    toast(error.message, true);
  }
}

async function removeMedia() {
  if (!script || !script.media) return;
  if (!confirm('确定解除这段音视频的关联吗？\n已标记的时间点也会一并移除。')) return;
  try {
    const res = await api('/api/workspaces/' + currentId + '/media', { method: 'DELETE' });
    const data = await res.json();
    stopPlayer();
    script = data.script;
    document.getElementById('mediaPlayerWrap').innerHTML = '';
    renderMedia();
    toast('已解除音视频关联。');
    await refreshList(currentId);
  } catch (error) {
    toast(error.message, true);
  }
}

function markCurrentTime() {
  const media = script && script.media;
  const player = document.getElementById('mediaPlayer');
  if (!media || !player) return;
  if (player.pause) player.pause();
  const at = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const exists = (media.cues || []).some(cue => Math.abs(cue.at - at) < 0.001);
  if (exists) { toast('该时间已存在时间点，可直接在列表中编辑。', true); return; }
  media.cues = media.cues || [];
  media.cues.push({ id: uid('cue-'), at: at, label: '', block_ids: [] });
  renderCueList();
  markCuesDirty();
  toast('已标记 ' + fmtStamp(at) + '，请为该时间点选择台词。');
}

function addCueRow() {
  const media = script && script.media;
  if (!media) return;
  media.cues = media.cues || [];
  media.cues.push({ id: uid('cue-'), at: 0, label: '', block_ids: [] });
  renderCueList();
  markCuesDirty();
}

function bindMediaEvents() {
  document.getElementById('btnMediaUpload').addEventListener('click', () => document.getElementById('fileMedia').click());
  document.getElementById('fileMedia').addEventListener('change', e => { uploadMedia(e.target.files[0]); e.target.value = ''; });
  document.getElementById('btnMediaRemove').addEventListener('click', removeMedia);
  document.getElementById('btnMarkCue').addEventListener('click', markCurrentTime);
  document.getElementById('btnAddCue').addEventListener('click', addCueRow);
  document.getElementById('btnSaveCues').addEventListener('click', saveCues);
}

async function quit() {
  if (!confirm('确定退出粉丝编辑器吗？\n已保存的内容都会保留在本机。')) return;
  try { await api('/api/shutdown', { method: 'POST' }); } catch (e) {}
  window.close();
}

document.getElementById('btnImport').addEventListener('click', () => document.getElementById('filePackage').click());
document.getElementById('filePackage').addEventListener('change', e => { importPackage(e.target.files[0]); e.target.value = ''; });
document.getElementById('btnQuit').addEventListener('click', quit);
document.getElementById('btnSave').addEventListener('click', save);
document.getElementById('btnExport').addEventListener('click', exportZip);
document.getElementById('btnAddText').addEventListener('click', addTextBlock);
document.getElementById('btnAddImage').addEventListener('click', () => document.getElementById('fileImage').click());
document.getElementById('fileImage').addEventListener('change', e => { addImageBlock(e.target.files[0]); e.target.value = ''; });
bindMediaEvents();

refreshList(null).catch(() => {});
