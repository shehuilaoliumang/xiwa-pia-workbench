'use strict';

(() => {
  const preview = new URLSearchParams(location.search).get('preview') === '1';
  const editorPreview = preview && new URLSearchParams(location.search).get('editor') === '1';
  const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent);
  const viewport = document.getElementById('display-viewport');
  const stage = document.getElementById('stage');
  const background = document.getElementById('stage-background');
  const scroll = document.getElementById('stage-scroll');
  const content = document.getElementById('stage-content');
  const kind = document.getElementById('stage-kind');
  const footer = document.getElementById('stage-footer-text');
  let csrf = bootstrap.csrf_token || document.querySelector('meta[name="csrf-token"]')?.content || '';
  const defaults = {font_size: 42, line_height: 1.8, padding: 72, background_opacity: 0.4, category_columns: 0, category_background_opacity: 0.8, body_mode: 'scroll', speed: 35};
  const rolePalette = ['#8C424E', '#3D6C61', '#4C5D85', '#7C5F36', '#705080', '#356976'];
  let state = null;
  let snapshotId = null;
  let renderedSnapshot = null;
  let mediaPlayer = null, mediaCommandQueued = null, mediaCommandRunning = false, audienceMediaHold = null;
  const previewMediaPositions = new Map();
  let seekVersion = null;
  let scale = 1;
  let anchorElements = [];
  let anchorMap = new Map();
  let positionVersion = 0;
  let positioning = false;
  let reflowAnchor = null;
  let manualHoldUntil = 0;
  let lastFrame = null;
  let lastAudiencePaint = performance.now();
  let fractionalDistance = 0;
  let connected = false;
  let connectionLost = false;
  let lastStateReceivedAt = -Infinity;
  let connecting = false;
  let polling = false;
  let checkpointBusy = false;
  let checkpointQueued = false;
  let checkpointTimer = 0;
  let lastSavedKey = '';
  let bottomRequest = false;
  let locallyAtEnd = false;
  let baseFooter = '收录正文 · 用声音相遇';
  let contentTransition = null;
  let previewPlaying = false;
  let previewLastFrame = null;
  let previewFractionalDistance = 0;
  let previewSelectedAnchor = null;
  let previewRenderVersion = 0;
  let previewAcknowledgedId = null;
  let previewCanApply = false;
  let previewStatusMessage = '预览草稿';
  let hoverAnchor = null;
  let hoverTimer = 0;
  let pageElements = [];
  let pageIndex = 0;
  let pageSource = null;
  let paginationVersion = 0;
  let paginationModule = null;
  let paginationError = false;
  let paginationRefreshTimer = 0;
  const previewPagePositions = new Map();
  let categoryPeek = null;
  let categoryPeekId = null;
  let categoryPeekTimer = 0;
  let previewToolbar = null;
  let previewButtons = {};
  let previewPlacement = 'inside';
  let previewFeedback = 'confirm';
  let previewPositionTimer = 0;
  let previewManualScrollPending = false;
  let previewToolsKey = '';
  const previewPositions = new Map();
  let previewLiveBinding = null;
  let previewSyncRate = 60;
  const motionScheduler = createMotionScheduler();
  const motionSentTimes = [], motionReceivedTimes = [];
  let motionActivityKey = '', motionActivityAt = -Infinity;
  let lastReceivedMotionWallTime = 0;
  let previewMotionSeq = Date.now() * 1000;
  let liveMotion = null;
  let previewVisibilityHold = false;
  let previewHiddenState = null;
  let previewResumePending = null;
  let previewResumeTimer = 0;
  let previewResumeSeq = 0;
  const previewResumeClient = Math.random().toString(36).slice(2);

  const futureMotions = new Map();
  let liveChannel = null;
  try {
    if (typeof BroadcastChannel === 'function') liveChannel = new BroadcastChannel('wb-live-display-v1');
  } catch (_) { /* Polling remains available when this browser blocks channels. */ }


  const text = value => value == null ? '' : String(value);
  const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  const pendingLayoutFrames = new Set();
  // Layout measurements must finish even when a background window gets no paint frames.
  const nextFrame = () => new Promise(resolve => {
    if (document.hidden) { resolve(); return; }
    let frame = 0, timer = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      pendingLayoutFrames.delete(finish);
      resolve();
    };
    pendingLayoutFrames.add(finish);
    frame = requestAnimationFrame(finish);
    timer = setTimeout(finish, 100);
  });
  // BEGIN MOTION SCHEDULER: kept pure so simulated refresh rates can be verified.
  function createMotionScheduler() {
    let nextAt = null, previousAt = null, currentRate = null;
    return {
      reset() { nextAt = null; previousAt = null; currentRate = null; },
      due(timestamp, rate, force = false) {
        const period = 1000 / rate;
        if (!Number.isFinite(timestamp) || !Number.isFinite(period) || period <= 0) return false;
        if (rate !== currentRate || previousAt == null || timestamp < previousAt || timestamp - previousAt > 250) {
          nextAt = timestamp; currentRate = rate;
        }
        previousAt = timestamp;
        if (!force && timestamp + 0.05 < nextAt) return false;
        // Keep phase at 90 Hz on a 120 Hz display; skip missed slots, never burst.
        nextAt = force ? timestamp + period : nextAt + (Math.floor(Math.max(0, timestamp + 0.05 - nextAt) / period) + 1) * period;
        return true;
      },
    };
  }
  // END MOTION SCHEDULER
  function motionRate(samples, now = performance.now()) {
    while (samples.length && samples[0] <= now - 1000) samples.shift();
    return samples.length;
  }
  function recordMotion(samples) { const now = performance.now(); motionRate(samples, now); samples.push(now); }
  function previewSyncStatus() {
    if (previewFeedback !== 'realtime') return 'confirm';
    if (!liveChannel) return 'unavailable';
    if (document.visibilityState === 'hidden' || previewVisibilityHold) return 'background';
    if (positioning) return 'updating';
    if (!previewLiveBinding || previewLiveBinding.snapshot_id !== snapshotId || previewAcknowledgedId !== snapshotId) return 'unbound';
    return (mediaPlayer ? mediaPlayer.playing : previewPlaying) || performance.now() - motionActivityAt < 1200 ? 'active' : 'idle';
  }
  function reportPreviewSync() {
    if (!preview) return;
    window.parent.postMessage({type: 'wb-preview-sync-metrics', snapshot_id: snapshotId,
      live_snapshot_id: previewLiveBinding?.live_snapshot_id ?? null, revision: previewLiveBinding?.revision ?? null,
      state: previewSyncStatus(), target_hz: previewSyncRate, media: Boolean(mediaPlayer),
      tx_hz: motionRate(motionSentTimes), sent_at: Date.now()}, location.origin);
  }
  const displayClient = Math.random().toString(36).slice(2);
  function reportDisplayHealth(visibility = document.visibilityState) {
    if (preview || !liveChannel) return;
    liveChannel.postMessage({type: 'display-health', client_id: displayClient, visibility,
      connected: connected && !connectionLost, positioning,
      sync: {rx_hz: motionRate(motionReceivedTimes), snapshot_id: state?.snapshot?.id ?? null, revision: state?.revision ?? null, last_motion_at: lastReceivedMotionWallTime}, sent_at: Date.now()});
  }

  async function waitForTransition(transition) {
    if (!transition) return;
    let timer;
    await Promise.race([transition.finished.catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 350); })]);
    clearTimeout(timer);
    if (contentTransition === transition) {
      transition.cancel();
      contentTransition = null;
    }
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }

  function safeMedia(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
    try {
      const url = new URL(value, location.origin);
      const decoded = decodeURIComponent(url.pathname);
      if (url.origin !== location.origin || url.search || url.hash || /[\\\u0000-\u001f]/.test(decoded)) return '';
      if (!decoded.startsWith('/static/media/') && !decoded.startsWith('/media/')) return '';
      if (decoded.split('/').some(part => part === '.' || part === '..')) return '';
      return url.pathname;
    } catch (_) {
      return '';
    }
  }

  function luminance(rgb) {
    const linear = rgb.map(value => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function readableColor(value, fallback = '#40382E') {
    if (!/^#[0-9a-f]{6}$/i.test(value || '')) return fallback;
    let rgb = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
    // The audience canvas has a light wash. Keep source hue where possible,
    // while making original white/light lettering legible on that surface.
    for (let attempt = 0; attempt < 6 && (0.92 + 0.05) / (luminance(rgb) + 0.05) < 4.5; attempt += 1) {
      rgb = rgb.map(channel => Math.round(channel * 0.75));
    }
    return '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('');
  }

  function roleColor(role) {
    let hash = 0;
    for (const char of text(role)) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
    return rolePalette[hash % rolePalette.length];
  }

  function fitStage() {
    const landscape = stage.classList.contains('landscape');
    const width = landscape ? 1920 : 1080;
    const height = landscape ? 1080 : 1920;
    const availableWidth = viewport.clientWidth;
    const availableHeight = viewport.clientHeight;
    if (!availableWidth || !availableHeight) return;
    scale = Math.min(availableWidth / width, availableHeight / height);
    stage.style.left = ((availableWidth - width * scale) / 2) + 'px';
    stage.style.top = ((availableHeight - height * scale) / 2) + 'px';
    stage.style.transform = `scale(${scale})`;
    stage.style.setProperty('--stage-scale', scale);
    if (preview && previewToolbar) {
      const space = previewPlacement === 'outside' || previewFeedback === 'realtime' ? 0 : previewToolbar.getBoundingClientRect().height + 26;
      content.style.setProperty('--preview-tool-space', Math.ceil(space / scale) + 'px');
    }
    positionCategoryPeek();
  }

  function markAnchor(node, value) {
    if (!value) return;
    bindContentHover(node, value);
    if (anchorMap.has(value)) return;
    node.dataset.anchor = value;
    anchorMap.set(value, node);
    anchorElements.push(node);
  }

  function relativeTop(node) {
    return (node.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / (scale || 1) + scroll.scrollTop;
  }

  function currentAnchor() {
    if(mediaPlayer){const script=renderedSnapshot.scripts[0],value=mediaPlayer.getState();return script.media.cues?.length?script.media.cues[value.caption_index]?.block_ids?.[0]||null:script.blocks?.[value.caption_index]?.id||null;}
    if (isPagesMode() && pageElements.length) {
      if (preview && previewSelectedAnchor && anchorMap.has(previewSelectedAnchor)) return previewSelectedAnchor;
      return pageAnchor(pageIndex);
    }
    if (preview && previewSelectedAnchor && anchorMap.has(previewSelectedAnchor)) return previewSelectedAnchor;
    if (scroll.scrollTop < 3 || !anchorElements.length) return null;
    let chosen = null;
    let bestTop = -Infinity;
    const edge = scroll.scrollTop + 4;
    for (const node of anchorElements) {
      const top = relativeTop(node);
      // In a two-column list, retain the first item of the visible row.
      if (top <= edge && top > bestTop + 0.5) {
        chosen = node.dataset.anchor;
        bestTop = top;
      }
    }
    return chosen;
  }

  function placeAnchor(anchor) {
    if (isPagesMode() && pageElements.length) {
      const index = anchor == null ? 0 : pageElements.findIndex(page => [...page.querySelectorAll('[data-anchor]')].some(node => node.dataset.anchor === anchor));
      setCurrentPage(Math.max(0, index));
      return;
    }
    const node = anchor == null ? null : anchorMap.get(anchor);
    const top = node ? Math.max(0, relativeTop(node)) : 0;
    scroll.scrollTop = top;
    fractionalDistance = 0;
    lastFrame = null;
  }

  function updateFooter() {
    footer.textContent = connectionLost ? '展示暂时暂停' : baseFooter;
  }

  function validHoverAnchor(value, snapshot) {
    if (value == null) return true;
    if (typeof value !== 'string' || !snapshot) return false;
    if (snapshot.mode === 'script') return (snapshot.scripts || []).some(script => (script.blocks || []).some(block => block.id === value));
    if (snapshot.directory_level === 'categories') return (snapshot.categories || []).some(category => 'category:' + category.id === value);
    return (snapshot.scripts || []).some(script => 'script:' + script.id === value);
  }

  function setHoverAnchor(value) {
    clearTimeout(hoverTimer);
    if (!validHoverAnchor(value, renderedSnapshot)) value = null;
    if (hoverAnchor === value) return;
    content.querySelectorAll('.content-hover').forEach(node => node.classList.remove('content-hover'));
    hoverAnchor = value;
    if (!value) return;
    const scope = isPagesMode() && pageElements.length ? pageElements[pageIndex] : content;
    [...scope.querySelectorAll('[data-anchor]')].filter(node => node.dataset.anchor === value).forEach(node => node.classList.add('content-hover'));
  }

  function bindContentHover(node, value) {
    if (!preview) return;
    const enter = () => setHoverAnchor(value);
    const leave = () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (node.contains(document.activeElement) || node.matches(':hover')) return;
        if (hoverAnchor === value) setHoverAnchor(null);
      }, 80);
    };
    node.addEventListener('pointerenter', enter);
    node.addEventListener('pointerleave', leave);
    node.addEventListener('focusin', enter);
    node.addEventListener('focusout', leave);
  }

  function isMediaMode() { return Boolean(renderedSnapshot?.mode==='script'&&renderedSnapshot.layout?.body_mode==='media'&&renderedSnapshot.scripts?.[0]?.media?.path); }
  function mediaKey(snapshot) {const script=snapshot?.scripts?.[0];return script?.media ? script.id+':'+script.media.path : null;}
  function validMediaState(value) {return value&&Number.isFinite(value.position)&&value.position>=0&&value.position<=86400*7&&Number.isInteger(value.caption_index)&&value.caption_index>=0&&(value.caption_page_index===undefined||Number.isInteger(value.caption_page_index)&&value.caption_page_index>=0&&value.caption_page_index<=100000)&&(value.cue_id==null||typeof value.cue_id==='string');}
  function mediaChanged(detail, owner) {
    if(owner!==snapshotId||!mediaPlayer)return;
    if(detail.reason==='caption-layout'){updatePreviewToolbar();if(preview&&previewAcknowledgedId===snapshotId)postPreviewPosition('render');return;}
    if(preview){previewPlaying=Boolean(detail.playing);updatePreviewToolbar();if(previewAcknowledgedId===snapshotId){postPreviewPosition('interaction');publishPreviewMotion(performance.now(),true);}return;}
    if(!connected||!state||state.snapshot?.id!==snapshotId)return;
    if(recentLiveMotion()&&detail.reason==='cue')return;
    audienceMediaHold=state.revision;
    mediaCommandQueued={action:'media',snapshot_id:snapshotId,revision:state.revision,media_state:detail.media_state,playing:Boolean(detail.playing)};
    void drainMediaCommands();
  }
  async function drainMediaCommands(){
    if(mediaCommandRunning)return;mediaCommandRunning=true;
    try{while(mediaCommandQueued){const job=mediaCommandQueued;mediaCommandQueued=null;if(job.snapshot_id!==state?.snapshot?.id)continue;
      try{const result=await api('/api/command',job);if(mediaCommandQueued?.revision===job.revision&&mediaCommandQueued.snapshot_id===job.snapshot_id)mediaCommandQueued.revision=result.revision;acceptState(result);liveChannel?.postMessage({type:'state',state:result});}
      catch(error){if(error.status!==409)setDisconnected();else await poll();}
      finally{audienceMediaHold=null;}
    }}finally{mediaCommandRunning=false;}
  }

  function isPagesMode() {
    return Boolean(renderedSnapshot?.mode === 'script' && renderedSnapshot.layout?.body_mode === 'pages' && !paginationError);
  }

  function pageStatus() {
    return {...(mediaPlayer?{media_state:mediaPlayer.getState(),media_caption_layout:renderedSnapshot.layout?.media_caption_layout||'pages',caption_page_index:mediaPlayer.captionPageIndex,caption_page_count:mediaPlayer.captionPageCount}:{}),body_mode:isMediaMode()?'media':isPagesMode() ? 'pages' : 'scroll', page_index:isPagesMode() && pageElements.length ? pageIndex : null,
      page_count:isPagesMode() ? pageElements.length : 0};
  }

  function pageAnchor(index) {
    if (index === 0) return null;
    return pageElements[index]?.querySelector('[data-anchor]')?.dataset.anchor || null;
  }

  function nodePageIndex(node) {
    const value = node.closest('.stage-page')?.dataset.pageIndex;
    return value == null ? null : Number(value);
  }

  function setCurrentPage(index) {
    if (!pageElements.length) return;
    const next = Math.min(pageElements.length - 1, Math.max(0, Math.trunc(Number(index) || 0)));
    if (next !== pageIndex) { clearPreviewSelection(); setHoverAnchor(null); }
    pageIndex = next;
    pageElements.forEach((page, number) => { page.classList.toggle('is-current', number === pageIndex); page.hidden = number !== pageIndex; });
    const counter = content.querySelector('.stage-page-counter');
    if (counter) counter.textContent = `第 ${pageIndex + 1} / ${pageElements.length} 页`;
    scroll.scrollTop = 0;
    if (preview) updatePreviewToolbar();
  }

  function turnPreviewPage(direction) {
    if (!preview || !isPagesMode() || !pageElements.length || positioning) return;
    cancelPreviewResume(); cancelPreviewPositionReport(); setPreviewPlaying(false); clearPreviewSelection();
    setCurrentPage(pageIndex + direction);
    postPreviewPosition('interaction');
  }

  function previewPagingKey(snapshot) {
    return previewContentKey(snapshot) + ':' + snapshot?.orientation + ':' + JSON.stringify(snapshot?.layout || {});
  }

  async function ensurePagination() {
    if (!isPagesMode() || pageElements.length || !renderedSnapshot?.scripts?.length) return;
    const version = paginationVersion;
    try {
      paginationModule ||= import('/static/pagination.js');
      const module = await paginationModule;
      if (version !== paginationVersion || !isPagesMode()) return;
      pageSource ||= content.cloneNode(true);
      const pages = module.paginate(pageSource, stage, scroll.clientWidth, Math.max(120, scroll.clientHeight - 64));
      if (version !== paginationVersion) return;
      pageElements = pages;
      const wrapper = element('div', 'stage-pages');
      wrapper.append(...pages);
      const counter = element('div', 'stage-page-counter');
      counter.setAttribute('aria-live', 'polite');
      content.replaceChildren(wrapper, counter);
      anchorMap = new Map(); anchorElements = [];
      pages.forEach(page => page.querySelectorAll('[data-anchor]').forEach(node => {
        const anchor = node.dataset.anchor; markAnchor(node, anchor);
        makePreviewBlockInteractive(node, {id:anchor, text:node.querySelector('.block-text')?.textContent || node.textContent,
          kind:node.matches('figure') ? 'image' : 'text'});
      }));
      setCurrentPage(0);
    } catch (error) {
      paginationError = true;
      stage.classList.remove('body-pages');
      baseFooter = '分页未完成，请减小字号或留白后重试';
      updateFooter();
      if (preview) { previewStatusMessage = error.message || baseFooter; updatePreviewToolbar(); }
    }
  }

  function refreshPagination() {
    if (!isPagesMode() || !pageElements.length || positioning) return;
    clearTimeout(paginationRefreshTimer);
    paginationRefreshTimer = setTimeout(() => {
      const anchor = currentAnchor(); pageElements = []; paginationVersion += 1;
      restorePosition(anchor);
    }, 100);
  }

  function replyPageRequest(message) {
    if (preview || !liveChannel || !state || !isPagesMode() || !pageElements.length || positioning ||
      typeof message.request_id !== 'string' || message.request_id.length > 120 ||
      message.snapshot_id !== state.snapshot?.id || message.revision !== state.revision) return;
    const step = message.type === 'page-step' ? (message.direction === 1 ? 1 : message.direction === -1 ? -1 : 0) : 0;
    if (message.type === 'page-step' && step === 0) return;
    const index = Math.max(0, Math.min(pageElements.length - 1, pageIndex + step));
    liveChannel.postMessage({type:message.type === 'page-step' ? 'page-report' : 'page-status', request_id:message.request_id,
      snapshot_id:state.snapshot.id, revision:state.revision, page_index:index, page_count:pageElements.length, anchor:pageAnchor(index)});
  }

  function renderEmpty(title = '本地内容管理 · 展示与播控。', message = '每一次开口，都是一个新的世界。') {
    const empty = element('div', 'stage-empty');
    empty.append(element('div', '', '“'), element('h1', '', title), element('p', '', message));
    content.append(empty);
  }

  function directoryViewKey(snapshot) {
    return snapshot?.mode === 'list'
      ? `list:${snapshot.directory_level || 'legacy'}:${snapshot.focus_category_id || ''}`
      : snapshot?.mode || '';
  }

  function canReturnFrom(snapshot) {
    return Boolean(snapshot && (snapshot.mode === 'script' ||
      (snapshot.mode === 'list' && snapshot.directory_level === 'scripts')));
  }

  function categoryColumns(snapshot) {
    const requested = Number(snapshot?.layout?.category_columns);
    if (Number.isInteger(requested) && requested >= 1 && requested <= 4) return requested;
    const count = snapshot?.categories?.length || 1;
    return Math.min(count, snapshot?.orientation === 'landscape' ? 3 : 2);
  }

  function validCategoryPeek(value, snapshot) {
    return value == null || (typeof value === 'string' && snapshot?.mode === 'list' &&
      snapshot.directory_level === 'categories' && categoryColumns(snapshot) === 1 &&
      (snapshot.categories || []).some(category => 'category:' + category.id === value));
  }

  function ensureCategoryPeek() {
    if (categoryPeek) return;
    categoryPeek = element('aside', 'stage-category-peek');
    categoryPeek.id = 'stage-category-peek';
    categoryPeek.hidden = true;
    categoryPeek.setAttribute('role', 'region');
    categoryPeek.setAttribute('aria-label', '分组条目摘要');
    categoryPeek.tabIndex = preview ? 0 : -1;
    categoryPeek.addEventListener('pointerenter', () => clearTimeout(categoryPeekTimer));
    categoryPeek.addEventListener('pointerleave', scheduleCategoryPeekHide);
    categoryPeek.addEventListener('focusin', () => clearTimeout(categoryPeekTimer));
    categoryPeek.addEventListener('focusout', event => {
      if (!categoryPeek.contains(event.relatedTarget)) scheduleCategoryPeekHide();
    });
    stage.append(categoryPeek);
  }

  function scheduleCategoryPeekHide() {
    if (!preview) return;
    clearTimeout(categoryPeekTimer);
    categoryPeekTimer = setTimeout(() => {
      const card = categoryPeekId ? anchorMap.get(categoryPeekId) : null;
      if (categoryPeek?.contains(document.activeElement) || card?.contains(document.activeElement) ||
        categoryPeek?.matches?.(':hover') || card?.matches?.(':hover')) return;
      setCategoryPeek(null);
    }, 160);
  }

  function setCategoryPeek(value) {
    clearTimeout(categoryPeekTimer);
    if (!validCategoryPeek(value, renderedSnapshot)) value = null;
    if (preview) document.body.classList.toggle('preview-category-peek-open', Boolean(value));
    if (categoryPeekId === value) { positionCategoryPeek(); return; }
    categoryPeekId = value;
    if (!value) {
      if (categoryPeek) { categoryPeek.hidden = true; delete categoryPeek.dataset.categoryPeek; }
      return;
    }
    ensureCategoryPeek();
    const category = renderedSnapshot.categories.find(item => 'category:' + item.id === value);
    const scripts = renderedSnapshot.scripts.filter(script => script.category_id === category.id).slice(0, 3);
    categoryPeek.replaceChildren();
    categoryPeek.dataset.categoryPeek = value;
    categoryPeek.append(element('h2', 'category-peek-heading', category.name));
    if (category.description) categoryPeek.append(element('p', 'category-peek-description', category.description));
    if (!scripts.length) categoryPeek.append(element('p', 'category-peek-empty', '暂无条目'));
    scripts.forEach(script => {
      const item = element('article', 'category-peek-script');
      item.append(element('h3', '', script.title));
      item.append(element('p', 'category-peek-synopsis', script.synopsis || '原目录未提供简介'));
      item.append(element('p', 'category-peek-meta', script.author ? '作者 / 来源 · ' + script.author : '原目录未提供作者'));
      item.append(element('p', 'category-peek-meta', script.cast_note ? '配音配置 · ' + script.cast_note : '原目录未提供配音配置'));
      categoryPeek.append(item);
    });
    categoryPeek.hidden = false;
    categoryPeek.scrollTop = 0;
    positionCategoryPeek();
  }

  function positionCategoryPeek() {
    if (!categoryPeek || categoryPeek.hidden || !categoryPeekId) return;
    const card = anchorMap.get(categoryPeekId);
    if (!card || !stage.classList.contains('category-single-column')) {
      categoryPeek.hidden = true;
      categoryPeekId = null;
      if (preview) document.body.classList.remove('preview-category-peek-open');
      delete categoryPeek.dataset.categoryPeek;
      return;
    }
    const width = scroll.clientWidth;
    const visibleTop = scroll.offsetTop;
    categoryPeek.style.left = (scroll.offsetLeft + width * 0.52) + 'px';
    categoryPeek.style.width = (width * 0.48) + 'px';
    categoryPeek.style.maxHeight = Math.max(80, scroll.clientHeight - 8) + 'px';
    const height = Math.min(categoryPeek.offsetHeight, scroll.clientHeight - 8);
    const target = visibleTop + relativeTop(card) - scroll.scrollTop;
    categoryPeek.style.top = Math.max(visibleTop, Math.min(target, visibleTop + scroll.clientHeight - height)) + 'px';
  }

  function renderCategories(snapshot) {
    const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
    const scripts = Array.isArray(snapshot.scripts) ? snapshot.scripts : [];
    content.append(element('h1', 'stage-collection-title', '选择一种故事'));
    content.append(element('p', 'stage-intro', `${categories.length} 个分组 · ${scripts.length} 篇条目`));
    if (!categories.length) {
      renderEmpty('故事正在候场', '当前暂无可展示的分组。');
      return;
    }
    const columns = categoryColumns(snapshot);
    const list = element('div', 'stage-category-list category-columns-' + columns);
    list.style.setProperty('--category-columns', columns);
    list.dataset.categoryColumns = String(columns);
    categories.forEach(category => {
      const entries = scripts.filter(script => script.category_id === category.id);
      const card = element('article', 'stage-category-card');
      markAnchor(card, 'category:' + category.id);
      const path = safeMedia(category.background);
      if (path) card.style.setProperty('--category-background', `url("${path}")`);
      card.style.setProperty('--category-color', readableColor(category.color, '#805D35'));
      card.append(element('span', 'stage-category-count', `${entries.length} 篇条目`));
      card.append(element('h2', '', category.name));
      if (category.description) card.append(element('p', 'stage-category-description', category.description));
      if (!entries.length) card.append(element('p', 'stage-category-empty', '暂无条目'));
      else {
        const samples = element('ul', 'stage-category-samples');
        entries.slice(0, 3).forEach(script => {
          const sample = element('li');
          sample.append(element('strong', '', script.title));
          samples.append(sample);
        });
        card.append(samples);
      }
      if (preview) {
        card.classList.add('preview-open-category');
        card.dataset.previewCategory = category.id;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', '打开分组：' + text(category.name));
        if (columns === 1) {
          card.setAttribute('aria-controls', 'stage-category-peek');
          const peek = () => setCategoryPeek('category:' + category.id);
          card.addEventListener('pointerenter', peek);
          card.addEventListener('pointerleave', scheduleCategoryPeekHide);
          card.addEventListener('focusin', peek);
          card.addEventListener('focusout', event => {
            if (!categoryPeek?.contains(event.relatedTarget)) scheduleCategoryPeekHide();
          });
        }

        const open = () => {
          cancelPreviewPositionReport();
          setPreviewPlaying(false);
          previewPositions.set(previewContentKey(renderedSnapshot), currentAnchor());
          postPreviewAction('open-category', {category_id: category.id, playing: false});
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); event.stopPropagation(); open();
          }
        });
      }
      list.append(card);
    });
    content.append(list);
  }

  function renderList(snapshot, categoryMap) {
    if (snapshot.directory_level === 'categories') {
      renderCategories(snapshot);
      return;
    }

    const scripts = Array.isArray(snapshot.scripts) ? snapshot.scripts : [];
    const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
    const focusCategory = categoryMap.get(snapshot.focus_category_id);
    content.append(element('h1', 'stage-collection-title', focusCategory?.name || (categories.length === 1 ? categories[0].name : '条目目录')));
    content.append(element('p', 'stage-intro', `共 ${scripts.length} 篇收录条目`));
    if (categories.length > 1 && snapshot.directory_level !== 'scripts') {
      const nav = element('nav', 'stage-category-nav');
      nav.setAttribute('aria-label', '本场条目分组');
      categories.forEach(category => nav.append(element('span', '', category.name)));
      content.append(nav);
    }
    if (!scripts.length) {
      renderEmpty('故事正在候场', '当前分组暂无可展示的条目。');
      return;
    }
    const list = element('div', 'stage-list');
    scripts.forEach((script, index) => {
      const card = element('article', 'stage-card');
      markAnchor(card, 'script:' + script.id);
      if (preview) {
        card.classList.add('preview-open-script');
        card.dataset.previewScript = script.id;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', '打开正文：' + text(script.title));
        const open = () => {
          setPreviewPlaying(false);
          previewPositions.set(previewContentKey(renderedSnapshot), currentAnchor());
          cancelPreviewPositionReport();
          postPreviewAction('open-script', {script_id: script.id, playing: false});
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            open();
          }
        });
      }
      const top = element('div', 'stage-card-top');
      top.append(element('span', 'stage-card-category', categoryMap.get(script.category_id)?.name || script.source_category || '未分组'));
      top.append(element('span', 'stage-card-number', String(index + 1).padStart(2, '0')));
      card.append(top, element('h2', '', script.title));
      card.append(element('p', 'stage-card-author', script.author ? '作者 / 来源 · ' + script.author : '原目录未提供作者'));
      card.append(element('p', 'stage-card-synopsis', script.synopsis || '原目录未提供简介'));
      card.append(element('p', 'stage-card-cast', script.cast_note ? '配音配置 · ' + script.cast_note : '原目录未提供配音配置'));
      if (Array.isArray(script.tags) && script.tags.length) {
        const tags = element('div', 'stage-script-tags');
        script.tags.forEach(tag => tags.append(element('span', '', tag)));
        card.append(tags);
      }
      list.append(card);
    });
    content.append(list);
  }

  function renderTextBlock(block) {
    const paragraph = element('div', 'text-block' + (block.role ? ' role-line' : ''));
    markAnchor(paragraph, block.id);
    const fallback = block.role ? roleColor(block.role) : '#40382E';
    const color = readableColor(block.color, fallback);
    paragraph.style.setProperty('--role-color', color);
    if (block.role) paragraph.append(element('span', 'role-label', block.role));
    const body = element('div', 'block-text');
    const original = text(block.text);
    const runs = Array.isArray(block.runs) ? block.runs : [];
    // Edits may leave historical runs in the record. Never let stale spans
    // replace the current source/edit text or silently drop a character.
    if (runs.length && runs.every(run => run && typeof run.text === 'string') && runs.map(run => run.text).join('') === original) {
      runs.forEach(run => {
        const span = element('span', '', run.text);
        span.style.color = readableColor(run.color, color);
        body.append(span);
      });
    } else {
      body.textContent = original;
    }
    paragraph.append(body);
    makePreviewBlockInteractive(paragraph, block);
    return paragraph;
  }

  function renderImageBlock(block) {
    const figure = element('figure', 'image-block');
    markAnchor(figure, block.id);
    const path = safeMedia(block.image_path);
    if (path) {
      const img = element('img');
      img.alt = text(block.text) || '条目插图';
      img.loading = 'eager';
      img.decoding = 'async';
      img.style.height = 'auto';
      img.src = path;
      img.addEventListener('error', () => {
        img.hidden = true;
        if (!figure.querySelector('.image-unavailable')) figure.prepend(element('p', 'image-unavailable', '这张插图暂时无法显示。'));
      });
      img.addEventListener('load', () => {
        if (isPagesMode() && pageElements.length) refreshPagination();
        const pending = reflowAnchor;
        if (!pending || pending.version !== positionVersion || positioning) return;
        nextFrame().then(() => {
          if (reflowAnchor === pending && pending.version === positionVersion) placeAnchor(pending.anchor);
        });
      });
      figure.append(img);
    } else {
      figure.append(element('p', 'image-unavailable', '这张插图暂时无法显示。'));
    }
    figure.append(element('figcaption', '', '条目插图'));
    makePreviewBlockInteractive(figure, block);
    return figure;
  }

  function renderScript(snapshot, categoryMap) {
    const scripts = Array.isArray(snapshot.scripts) ? snapshot.scripts : [];
    if (!scripts.length) {
      renderEmpty('故事正在候场', '请在工作台选择要展示的条目。');
      return;
    }
    scripts.forEach(script => {
      const heading = element('header', 'stage-script-heading');
      heading.append(element('p', '', categoryMap.get(script.category_id)?.name || script.source_category || '条目正文'));
      heading.append(element('h1', '', script.title));
      if (script.author) heading.append(element('p', '', '作者 / 来源 · ' + script.author));
      if (script.cast_note) heading.append(element('small', '', '配音配置 · ' + script.cast_note));
      content.append(heading);
      const body = element('article', 'stage-body');
      for (const block of Array.isArray(script.blocks) ? script.blocks : []) {
        body.append(block.kind === 'image' ? renderImageBlock(block) : renderTextBlock(block));
      }
      content.append(body);
    });
  }

  function renderSnapshot(snapshot) {
    const oldView = directoryViewKey(renderedSnapshot);
    if(mediaPlayer){mediaPlayer.destroy();mediaPlayer=null;}
    audienceMediaHold=null;
    setCategoryPeek(null);
    setHoverAnchor(null);
    paginationVersion += 1;
    pageElements = [];
    pageIndex = 0;
    pageSource = null;
    paginationError = false;
    if (contentTransition) {
      contentTransition.cancel();
      contentTransition = null;
    }
    renderedSnapshot = snapshot || null;
    stage.classList.toggle('body-pages', isPagesMode());
    stage.classList.toggle('body-media', isMediaMode());
    snapshotId = snapshot?.id || null;
    anchorElements = [];
    anchorMap = new Map();
    content.replaceChildren();
    const orientation = snapshot?.orientation === 'landscape' ? 'landscape' : 'portrait';
    stage.classList.toggle('landscape', orientation === 'landscape');
    stage.classList.toggle('portrait', orientation === 'portrait');
    stage.classList.toggle('category-single-column', Boolean(snapshot?.mode === 'list' && snapshot.directory_level === 'categories' && categoryColumns(snapshot) === 1));
    const layout = {...defaults, ...(snapshot?.layout || {})};
    stage.style.setProperty('--stage-font', clamp(layout.font_size, 16, 96, defaults.font_size) + 'px');
    stage.style.setProperty('--stage-line', clamp(layout.line_height, 1.1, 3, defaults.line_height));
    stage.style.setProperty('--stage-padding', clamp(layout.padding, 12, 200, defaults.padding) + 'px');
    stage.style.setProperty('--background-opacity', clamp(layout.background_opacity, 0, 1, defaults.background_opacity));
    stage.style.setProperty('--category-background-opacity', clamp(layout.category_background_opacity, 0, 1, defaults.category_background_opacity));
    const categories = Array.isArray(snapshot?.categories) ? snapshot.categories : [];
    const categoryMap = new Map(categories.map(category => [category.id, category]));
    const theme = snapshot?.mode === 'script' ? categoryMap.get(snapshot.scripts?.[0]?.category_id) || categories[0] : categories[0];
    const backgroundPath = safeMedia(theme?.background);
    background.style.backgroundImage = backgroundPath ? `url("${backgroundPath}")` : 'none';
    stage.style.setProperty('--stage-color', readableColor(theme?.color, '#9F7650'));
    if (!snapshot) {
      kind.textContent = '故事正在候场';
      baseFooter = '收录正文 · 用声音相遇';
      renderEmpty();
    } else if (snapshot.mode === 'script') {
      kind.textContent = '收录正文';
      baseFooter = '正文与选段 · 用声音相遇';
      if(isMediaMode()){
        kind.textContent=snapshot.scripts[0].title+' · 音视频配本';baseFooter='读完台词后，手动继续';
        const owner=snapshot.id;mediaPlayer=new window.PiaMediaPlayer({container:content,script:snapshot.scripts[0],layout,preview,onChange:detail=>mediaChanged(detail,owner)});
      }else renderScript(snapshot, categoryMap);
    } else {
      kind.textContent = '选一个故事，开始相遇';
      baseFooter = `${snapshot.scripts?.length || 0} 篇收录条目`;
      renderList(snapshot, categoryMap);
    }
    fitStage();
    updateFooter();
    if (!document.hidden && oldView && snapshot?.mode && oldView !== directoryViewKey(snapshot) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof content.animate === 'function') {
      const enteringScript = snapshot.mode === 'script';
      const animation = content.animate([
        {opacity: 0, transform: `translateY(${enteringScript ? 22 : -16}px)`},
        {opacity: 1, transform: 'translateY(0)'}
      ], {duration: 270, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'none'});
      contentTransition = animation;
      animation.finished.catch(() => {}).then(() => {
        if (contentTransition === animation) contentTransition = null;
      });
    }
  }

  async function waitForLayout() {
    const images = [...content.querySelectorAll('img')];
    const imageReady = Promise.all(images.map(img => new Promise(resolve => {
      if (img.complete) {
        if (img.decode && img.naturalWidth) img.decode().catch(() => {}).then(resolve);
        else resolve();
        return;
      }
      const finish = () => {
        img.removeEventListener('load', finish);
        img.removeEventListener('error', finish);
        resolve();
      };
      img.addEventListener('load', finish, {once: true});
      img.addEventListener('error', finish, {once: true});
    })));
    let timeout;
    await Promise.race([imageReady, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]);
    clearTimeout(timeout);
    if (document.fonts?.status === 'loading') await document.fonts.ready;
    await nextFrame();
    await nextFrame();
  }

  async function restorePosition(anchor, preferMotion = false, requestedPage = null) {
    const version = ++positionVersion;
    positioning = true;
    if (preview) updatePreviewToolbar();
    reflowAnchor = {version, anchor};
    fractionalDistance = 0;
    lastFrame = null;
    const transition = contentTransition;
    await Promise.all([waitForLayout(), waitForTransition(transition)]);
    if (version !== positionVersion) return;
    await ensurePagination();
    // A new state revision can arrive one channel task before its exact motion.
    // Allow that frame to arrive before falling back to a semantic paragraph.
    if (!preview && preferMotion) {
      const deadline = performance.now() + 160;
      while (!document.hidden && version === positionVersion && !recentLiveMotion() && performance.now() < deadline) await nextFrame();
    }
    if (version !== positionVersion) return;
    positioning = false;
    if (!preview && recentLiveMotion()) applyLiveMotion();
    else if (isPagesMode() && pageElements.length && Number.isInteger(requestedPage) && requestedPage >= 0) setCurrentPage(requestedPage);
    else if(!mediaPlayer)placeAnchor(anchor);
    lastFrame = performance.now();
    locallyAtEnd = false;
    reportDisplayHealth();
    if (preview) updatePreviewToolbar();
  }

  async function api(path, body, {method = 'POST', keepalive = false, refreshed = false} = {}) {
    if (preview) throw new Error('Preview cannot access live control endpoints.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', keepalive,
        signal: controller.signal,
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 403 && data.code === 'csrf_failed' && !refreshed && !keepalive) {
        // A restarted local service creates a new CSRF token. Refresh it once,
        // without reconnecting or resetting a currently active presentation.
        const freshResponse = await fetch('/api/library', {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        const fresh = await freshResponse.json().catch(() => ({}));
        if (freshResponse.ok && typeof fresh.csrf_token === 'string' && fresh.csrf_token) {
          csrf = fresh.csrf_token;
          return await api(path, body, {method, keepalive, refreshed: true});
        }
      }
      if (!response.ok) {
        const error = new Error(data.error || '本地工作台暂时不可用');
        error.status = response.status;
        error.code = data.code;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function acceptState(next) {
    if (!next || !Number.isFinite(Number(next.revision))) return;
    if (state && Number(next.revision) < Number(state.revision)) return;
    const previous = state;
    const wasFollowingMotion = recentLiveMotion();
    const changedSnapshot = (next.snapshot?.id || null) !== snapshotId;
    const changedSeek = next.seek_version !== seekVersion;
    // A new command starts a new timing interval; never charge paused time to it.
    const receivedAt = performance.now();
    if (changedSnapshot || changedSeek || previous?.revision !== next.revision ||
      previous?.playing !== next.playing || previous?.speed !== next.speed || receivedAt - lastStateReceivedAt > 5000) lastFrame = receivedAt;
    lastStateReceivedAt = receivedAt;
    state = next;
    const motionKey = `${next.snapshot?.id || ''}:${next.revision}`;
    if (liveMotion && (liveMotion.snapshot_id !== next.snapshot?.id || liveMotion.revision !== next.revision)) liveMotion = null;
    const buffered = futureMotions.get(motionKey);
    if (buffered && Date.now() - buffered.sent_at <= 500 && validCategoryPeek(buffered.category_peek, next.snapshot) && validHoverAnchor(buffered.hover_anchor, next.snapshot)) liveMotion = buffered;
    futureMotions.delete(motionKey);
    seekVersion = next.seek_version;
    connectionLost = false;
    if (changedSnapshot) {
      renderSnapshot(next.snapshot);
      lastSavedKey = '';
    }
    if (changedSnapshot || changedSeek) {
      clearTimeout(checkpointTimer);
      checkpointQueued = false;
      locallyAtEnd = false;
      if (!changedSnapshot && recentLiveMotion()) {
        positionVersion += 1;
        positioning = false;
        applyLiveMotion();
      } else restorePosition(next.anchor, wasFollowingMotion, next.page_index);

    }
    if(mediaPlayer&&(changedSnapshot||changedSeek||previous?.playing!==next.playing)){
      const position=changedSnapshot||changedSeek?next.media_state:mediaPlayer.getState();
      mediaPlayer.setState(position||{position:0,caption_index:0,cue_id:null},Boolean(next.playing),{remote:true});
    }
    if (!positioning && recentLiveMotion()) applyLiveMotion();
    if (!next.playing) {
      fractionalDistance = 0;
      lastFrame = null;
    }
    updateFooter();
    // A pause response carries the server's last checkpoint. Keep the actual
    // local pixel position and save its semantic anchor at the new revision.
    if (previous?.playing && !next.playing && !changedSnapshot && !changedSeek) scheduleCheckpoint(0);
  }

  function setDisconnected() {
    connectionLost = true;
    if(mediaPlayer)mediaPlayer.setState(mediaPlayer.getState(),false,{remote:true});
    lastFrame = null;
    fractionalDistance = 0;
    updateFooter();
  }

  async function checkpoint({keepalive = false} = {}) {
    if (preview || !connected || !state?.snapshot || (!anchorElements.length&&!mediaPlayer) || positioning) return;
    if (checkpointBusy) {
      checkpointQueued = true;
      return;
    }
    const payload = {revision: state.revision, anchor: currentAnchor(), ...(mediaPlayer?{media_state:mediaPlayer.getState()}:{}), ...(isPagesMode() && pageElements.length ? {page_index:pageIndex} : {})};
    const key = `${snapshotId}:${payload.revision}:${payload.anchor ?? '<top>'}:${payload.page_index ?? 'scroll'}:${payload.media_state?JSON.stringify(payload.media_state):''}`;
    if (key === lastSavedKey) return;
    checkpointBusy = true;
    try {
      await api('/api/checkpoint', payload, {keepalive});
      lastSavedKey = key;
    } catch (error) {
      // A new control command wins over a checkpoint from an older revision.
      // The next poll refreshes state; never retry with an old saved position.
      if (error.status !== 409) setDisconnected();
    } finally {
      checkpointBusy = false;
      if (checkpointQueued) {
        checkpointQueued = false;
        scheduleCheckpoint(100);
      }
    }
  }

  function scheduleCheckpoint(delay = 300) {
    if (preview || !connected) return;
    clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => checkpoint(), delay);
  }

  async function pauseAtEnd() {
    if (preview || bottomRequest || !connected || !state?.playing) return;
    bottomRequest = true;
    locallyAtEnd = true;
    fractionalDistance = 0;
    try {
      const result = await api('/api/command', {action: 'pause'});
      acceptState(result);
      scheduleCheckpoint(0);
    } catch (_) {
      setDisconnected();
    } finally {
      bottomRequest = false;
    }
  }

  function animate(timestamp) {
    requestAnimationFrame(animate);
    lastAudiencePaint = performance.now();
    if (!document.hidden) advanceAudience(timestamp);
  }

  function advanceAudience(timestamp, backgroundTick = false) {
    // After a browser freeze, refresh commands before extrapolating an old play state.
    if (backgroundTick && timestamp - lastStateReceivedAt > 5000) { lastFrame = null; return; }
    if(mediaPlayer)mediaPlayer.setFollower?.(Boolean(recentLiveMotion()));
    if (!recentLiveMotion()) { if (categoryPeekId) setCategoryPeek(null); if (hoverAnchor) setHoverAnchor(null); }
    if (preview || isMediaMode() || isPagesMode() || !connected || !state?.playing || !state.snapshot || positioning || connectionLost || locallyAtEnd || recentLiveMotion() || timestamp < manualHoldUntil) {
      lastFrame = null;
      return;
    }
    const interval = lastFrame == null ? 0 : Math.max(0, (timestamp - lastFrame) / 1000);
    const elapsed = backgroundTick ? interval : Math.min(interval, 0.12);
    lastFrame = timestamp;
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (scroll.scrollTop >= maxScroll - 1) {
      pauseAtEnd();
      return;
    }
    fractionalDistance += clamp(state.speed, 5, 180, defaults.speed) * elapsed;
    const distance = Math.floor(fractionalDistance);
    if (distance > 0) {
      reflowAnchor = null;
      scroll.scrollTop = Math.min(maxScroll, scroll.scrollTop + distance);
      fractionalDistance -= distance;
    }
  }

  function manualIntent(event) {
    // Preview arrows belong to semantic navigation, including protected edit
    // targets. Never let the generic scroll reporter overwrite that result.
    if(preview&&event.type==='keydown'&&isPreviewArrow(event.key))return;
    if(isMediaMode())return;
    if (preview && (event.target?.closest?.('.preview-toolbar') || event.target?.closest?.('.stage-category-peek'))) return;
    if (event.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
    positionVersion += 1;
    positioning = false;
    reflowAnchor = null;
    locallyAtEnd = false;
    fractionalDistance = 0;
    lastFrame = null;
    manualHoldUntil = performance.now() + 350;
    if (preview) {
      cancelPreviewResume();
      clearPreviewSelection();
      previewLastFrame = null;
      previewFractionalDistance = 0;
      // A deliberate wheel/touch/keyboard gesture takes over from trial play.
      // Only the final settled position is published, never each scroll frame.
      setPreviewPlaying(false);
      previewManualScrollPending = true;
      schedulePreviewPositionReport();
    }
  }

  function previewContentKey(snapshot) {
    return snapshot ? directoryViewKey(snapshot) + ':' + (snapshot.categories || []).map(category => category.id).join('|') + ':' + (snapshot.scripts || []).map(script => script.id).join('|') : '';
  }

  function postPreviewAction(action, details = {}) {
    if (!preview || !renderedSnapshot) return;
    cancelPreviewResume();
    if (action === 'apply' && (!previewCanApply || previewAcknowledgedId !== snapshotId || positioning)) return;
    window.parent.postMessage({type: 'wb-preview-action', action, snapshot_id: snapshotId, ...pageStatus(), ...details}, location.origin);
  }

  function postPreviewPosition(reason, anchor = currentAnchor()) {
    if (!preview || !renderedSnapshot || previewAcknowledgedId !== snapshotId || positioning) return;
    window.parent.postMessage({type: 'wb-preview-position', snapshot_id: snapshotId,
      anchor, playing: mediaPlayer?mediaPlayer.playing:previewPlaying, reason, ...pageStatus()}, location.origin);
  }

  function cancelPreviewPositionReport() {
    clearTimeout(previewPositionTimer);
    previewManualScrollPending = false;
  }

  function schedulePreviewPositionReport() {
    clearTimeout(previewPositionTimer);
    previewPositionTimer = setTimeout(() => {
      if (!previewManualScrollPending) return;
      previewManualScrollPending = false;
      postPreviewPosition('interaction');
    }, 150);
  }

  function clearPreviewSelection() {
    content.querySelectorAll('.preview-selected').forEach(node => node.classList.remove('preview-selected'));
    previewSelectedAnchor = null;
  }

  function selectPreviewAnchor(anchor, targetPage = null) {
    if (!preview || (anchor != null && !anchorMap.has(anchor))) return;
    cancelPreviewResume();
    cancelPreviewPositionReport();
    setPreviewPlaying(false);
    positionVersion += 1;
    positioning = false;
    reflowAnchor = null;
    clearPreviewSelection();
    if (isPagesMode() && Number.isInteger(targetPage)) setCurrentPage(targetPage);
    else placeAnchor(anchor);
    previewSelectedAnchor = anchor;
    const selected = isPagesMode() ? [...(pageElements[pageIndex]?.querySelectorAll('[data-anchor]') || [])].find(node => node.dataset.anchor === anchor) : anchorMap.get(anchor);
    if (anchor) selected?.classList.add('preview-selected');
    updatePreviewToolbar();
    postPreviewPosition('interaction');
  }

  function focusEditorAnchor(message) {
    if (!editorPreview || renderedSnapshot?.editor_only !== true || renderedSnapshot.mode !== 'script' ||
      message.snapshot_id !== snapshotId || previewAcknowledgedId !== snapshotId || positioning ||
      typeof message.anchor !== 'string' || !anchorMap.has(message.anchor)) return;
    const anchor = message.anchor;
    let targetPage = null;
    if (isPagesMode()) {
      const containsAnchor = page => [...(page?.querySelectorAll('[data-anchor]') || [])]
        .some(node => node.dataset.anchor === anchor);
      // Long paragraphs span pages. Preserve the part currently visible.
      targetPage = containsAnchor(pageElements[pageIndex]) ? pageIndex : pageElements.findIndex(containsAnchor);
      if (targetPage < 0) return;
    }
    cancelPreviewPositionReport();
    previewPlaying = false;
    previewLastFrame = null;
    previewFractionalDistance = 0;
    positionVersion += 1;
    reflowAnchor = null;
    clearPreviewSelection();
    if (targetPage !== null) setCurrentPage(targetPage);
    else placeAnchor(anchor);
    previewSelectedAnchor = anchor;
    const selected = isPagesMode()
      ? [...(pageElements[pageIndex]?.querySelectorAll('[data-anchor]') || [])].find(node => node.dataset.anchor === anchor)
      : anchorMap.get(anchor);
    selected?.classList.add('preview-selected');
    updatePreviewToolbar();
    // Dedicated acknowledgement cannot be interpreted as a user/live action.
    window.parent.postMessage({type: 'wb-editor-focused', snapshot_id: snapshotId, anchor,
      page_status: pageStatus(), ...pageStatus()}, location.origin);
  }

  function makePreviewBlockInteractive(node, block) {
    if (!preview || !block.id) return;
    node.classList.add('preview-selectable-block');
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    const label = block.kind === 'image' ? '条目插图' : text(block.text).trim().slice(0, 38);
    node.setAttribute('aria-label', '定位到：' + label);
    node.addEventListener('click', () => selectPreviewAnchor(block.id, nodePageIndex(node)));
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        selectPreviewAnchor(block.id, nodePageIndex(node));
      }
    });
  }

  function setPreviewPlaying(playing, reason = null) {
    if (!preview) return;
    if (editorPreview) playing = false;
    if(mediaPlayer){
      if(reason==='interaction'){if(playing)void mediaPlayer.play();else mediaPlayer.pause();}
      else mediaPlayer.setState(mediaPlayer.getState(),Boolean(playing),{remote:true});
      previewPlaying=mediaPlayer.playing;updatePreviewToolbar();return;
    }
    if (reason === 'interaction') cancelPreviewResume();
    const anchor = currentAnchor();
    previewPlaying = Boolean(playing && !isPagesMode() && renderedSnapshot && anchorElements.length);
    previewLastFrame = null;
    previewFractionalDistance = 0;
    if (previewPlaying) {
      clearPreviewSelection();
      reflowAnchor = null;
    }
    updatePreviewToolbar();
    if (reason) postPreviewPosition(reason, anchor);
  }

  function stepPreview(direction) {
    const ids = anchorElements.map(node => node.dataset.anchor);
    if (!ids.length) return;
    const current = currentAnchor();
    const index = current == null ? -1 : ids.indexOf(current);
    const next = index + direction;
    selectPreviewAnchor(next < 0 ? null : ids[Math.min(next, ids.length - 1)]);
  }

  function updatePreviewToolbar() {
    if (!previewToolbar) return;
    const hasSnapshot = Boolean(renderedSnapshot);
    const hasContent = hasSnapshot && (anchorElements.length > 0||Boolean(mediaPlayer));
    const canApply = hasSnapshot && previewCanApply && previewAcknowledgedId === snapshotId && !positioning;
    previewButtons.returnList.disabled = !canReturnFrom(renderedSnapshot);
    previewButtons.returnList.textContent = renderedSnapshot?.mode === 'list' && renderedSnapshot.directory_level === 'scripts' ? '返回分组' : '返回目录';
    previewButtons.play.disabled = editorPreview || !hasContent || positioning || isPagesMode();
    previewButtons.play.textContent = previewFeedback === 'realtime'
      ? (previewPlaying ? '暂停滚动' : '开始滚动') : (previewPlaying ? '暂停试滚' : '预览试滚');
    if(mediaPlayer)previewButtons.play.textContent=previewPlaying?'暂停媒体':'播放 / 读完继续';
    previewButtons.previous.textContent=mediaPlayer?'上一组台词':'上一段';previewButtons.next.textContent=mediaPlayer?'下一组台词':'下一段';previewButtons.top.textContent=mediaPlayer?'回到开头':'回顶部';
    previewButtons.play.setAttribute('aria-pressed', String(previewPlaying));
    previewButtons.previous.hidden = isPagesMode();
    previewButtons.next.hidden = isPagesMode();
    const captionPages=Boolean(mediaPlayer&&renderedSnapshot.layout?.media_caption_layout!=='scroll');
    const hasPages=isPagesMode()||captionPages,currentPage=captionPages?mediaPlayer.captionPageIndex:pageIndex,count=captionPages?mediaPlayer.captionPageCount:pageElements.length;
    previewButtons.previousPage.hidden = !hasPages;
    previewButtons.nextPage.hidden = !hasPages;
    previewButtons.previousPage.disabled = !count || currentPage <= 0 || positioning;
    previewButtons.nextPage.disabled = !count || currentPage >= count - 1 || positioning;
    previewButtons.previousPage.textContent=captionPages?'台词上一页':'上一页';previewButtons.nextPage.textContent=captionPages?'台词下一页':'下一页';
    previewButtons.previous.disabled = !hasContent;
    previewButtons.next.disabled = !hasContent;
    previewButtons.top.disabled = !hasSnapshot;
    previewButtons.smaller.disabled = !hasSnapshot;
    previewButtons.larger.disabled = !hasSnapshot;
    previewButtons.apply.disabled = !canApply;
    previewButtons.apply.textContent = previewFeedback === 'realtime' ? '立即同步' : '应用到展示';
    previewButtons.status.textContent = previewFeedback === 'realtime' ? previewStatusMessage
      : previewPlaying ? '仅预览试滚 · 不改变当前展示' : previewStatusMessage;
    const toolsState = {type: 'wb-preview-tools', snapshot_id: snapshotId,
      mode: renderedSnapshot?.mode || 'list', directory_level: renderedSnapshot?.directory_level || null,
      focus_category_id: renderedSnapshot?.focus_category_id || null, can_return: canReturnFrom(renderedSnapshot), has_content: hasContent,
      playing: previewPlaying, can_apply: canApply, positioning, ...pageStatus()};
    const key = JSON.stringify(toolsState);
    // Parent status messages can call this function again. Deduplication keeps
    // tools/status feedback from becoming a message loop or a user action.
    if (key !== previewToolsKey) {
      previewToolsKey = key;
      window.parent.postMessage(toolsState, location.origin);
    }
  }

  function applyPreview() {
    if (!renderedSnapshot || !previewCanApply || previewAcknowledgedId !== snapshotId || positioning) return;
    cancelPreviewPositionReport();
    // Confirm mode retains its paused hand-off. Realtime mode sends the
    // current play intent so the parent owns the serialized publishing flow.
    if (previewFeedback === 'confirm') setPreviewPlaying(false);
    postPreviewAction('apply', {anchor: currentAnchor(), playing: previewPlaying});
  }

  function runPreviewCommand(action) {
    if (!renderedSnapshot) return;
    if (editorPreview && !['previous', 'next', 'previous-page', 'next-page', 'top'].includes(action)) return;
    switch (action) {
      case 'return-list':
        if (!canReturnFrom(renderedSnapshot)) return;
        cancelPreviewPositionReport();
        setPreviewPlaying(false);
        postPreviewAction('return-list', {playing: false});
        break;
      case 'play':
        if ((!anchorElements.length&&!mediaPlayer) || positioning || isPagesMode()) return;
        cancelPreviewPositionReport();
        setPreviewPlaying(!previewPlaying, 'interaction');
        break;
      case 'previous-page': if(mediaPlayer)mediaPlayer.previousCaptionPage();else turnPreviewPage(-1); break;
      case 'next-page': if(mediaPlayer)mediaPlayer.nextCaptionPage();else turnPreviewPage(1); break;
      case 'previous': if(mediaPlayer)mediaPlayer.previousCaption();else stepPreview(-1); break;
      case 'next': if(mediaPlayer)mediaPlayer.nextCaption();else stepPreview(1); break;
      case 'top': if(mediaPlayer)mediaPlayer.seek(0);else selectPreviewAnchor(null); break;
      case 'font-smaller':
      case 'font-larger':
        cancelPreviewPositionReport();
        setPreviewPlaying(false);
        postPreviewAction('font', {delta: action === 'font-smaller' ? -2 : 2,
          anchor: currentAnchor(), playing: false});
        break;
      case 'apply': applyPreview(); break;
      default: break;
    }
  }

  function isPreviewArrow(key) {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key);
  }

  function previewKeyReady() {
    return preview && renderedSnapshot && previewAcknowledgedId === snapshotId && !positioning;
  }

  function protectedPreviewKeyTarget(target) {
    if (!(target instanceof Element)) return false;
    return target.isContentEditable || Boolean(target.closest('input,textarea,select,[role="textbox"],[role="combobox"],[role="slider"],:disabled,[aria-disabled="true"],[inert]'));
  }

  function runPreviewKey(key) {
    if (!isPreviewArrow(key) || !previewKeyReady()) return false;
    const forward = key === 'ArrowRight' || key === 'ArrowDown';
    if (renderedSnapshot.mode === 'list') {
      const cards = [...content.querySelectorAll('[data-preview-category],[data-preview-script]')]
        .filter(card => !card.matches(':disabled,[aria-disabled="true"]') && card.getClientRects().length);
      if (!cards.length) return false;
      const current = cards.findIndex(card => card === document.activeElement || card.contains(document.activeElement));
      const columns = Math.max(1, (getComputedStyle(cards[0].parentElement).gridTemplateColumns || '').split(/\s+/).filter(Boolean).length);
      const step = key === 'ArrowUp' || key === 'ArrowDown' ? columns : 1;
      const next = current < 0 ? (forward ? 0 : cards.length - 1) : Math.max(0, Math.min(cards.length - 1, current + (forward ? step : -step)));
      if (next === current) return false;
      selectPreviewAnchor(cards[next].dataset.anchor);
      cards[next].focus({preventScroll: true});
      return true;
    }
    if (isPagesMode()) {
      const button = forward ? previewButtons.nextPage : previewButtons.previousPage;
      if (!button || button.disabled) return false;
      runPreviewCommand(forward ? 'next-page' : 'previous-page');
      return true;
    }
    if (mediaPlayer) {
      if(renderedSnapshot.layout?.media_caption_layout!=='scroll'&&['ArrowLeft','ArrowRight'].includes(key)){
        if(!mediaPlayer.captionPageCount||(forward?mediaPlayer.captionPageIndex>=mediaPlayer.captionPageCount-1:mediaPlayer.captionPageIndex<=0))return false;
        runPreviewCommand(forward?'next-page':'previous-page');return true;
      }
      const index = mediaPlayer.getState().caption_index;
      if (!mediaPlayer.groupCount || (forward ? index >= mediaPlayer.groupCount - 1 : index <= 0)) return false;
    } else {
      if (!anchorElements.length) return false;
      const anchor = currentAnchor();
      if ((!forward && anchor == null) || (forward && anchor === anchorElements.at(-1)?.dataset.anchor)) return false;
    }
    cancelPreviewResume();
    cancelPreviewPositionReport();
    runPreviewCommand(forward ? 'next' : 'previous');
    return true;
  }

  function previewKeydown(event) {
    if ((!isPreviewArrow(event.key) && event.key !== 'Escape') || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || protectedPreviewKeyTarget(event.target) || !previewKeyReady()) return;
    // A held key must not race through pages or emit repeated live updates.
    if (event.repeat) { event.preventDefault(); return; }
    if (event.key === 'Escape') {
      window.parent.postMessage({type: 'wb-preview-exit-focus', snapshot_id: snapshotId}, location.origin);
      event.preventDefault();
      return;
    }
    const hasTargets = renderedSnapshot.mode === 'list'
      ? content.querySelector('[data-preview-category],[data-preview-script]')
      : isPagesMode() ? pageElements.length : mediaPlayer ? mediaPlayer.groupCount : anchorElements.length;
    // At the first/last item, consume the semantic arrow without publishing an
    // interaction. Its browser default must not scroll the frame or parent.
    if (runPreviewKey(event.key) || hasTargets) event.preventDefault();
  }

  function setPreviewOptions(options) {
    if (options.placement === 'inside' || options.placement === 'outside') previewPlacement = options.placement;
    if (options.feedback === 'confirm' || options.feedback === 'realtime') previewFeedback = options.feedback;
    if ([30, 60, 90, 120].includes(options.sync_rate) && options.sync_rate !== previewSyncRate) { previewSyncRate = options.sync_rate; motionScheduler.reset(); motionSentTimes.length = 0; }
    if (previewFeedback !== 'realtime') { previewLiveBinding = null; cancelPreviewResume(); }
    reportPreviewSync();
    document.body.classList.toggle('preview-realtime', previewFeedback === 'realtime');
    previewToolbar.hidden = previewPlacement === 'outside';
    document.body.classList.toggle('preview-tools-outside', previewPlacement === 'outside');
    updatePreviewToolbar();
    fitStage();
  }

  function createPreviewToolbar() {
    previewToolbar = element('aside', 'preview-toolbar');
    previewToolbar.setAttribute('aria-label', '预览操作');
    const heading = element('div', 'preview-toolbar-heading');
    heading.append(element('strong', '', '预览操作'));
    previewButtons.status = element('span', 'preview-toolbar-status', '预览草稿');
    previewButtons.status.setAttribute('aria-live', 'polite');
    heading.append(previewButtons.status);
    const actions = element('div', 'preview-toolbar-actions');
    const identifiers = {returnList: 'return-list', play: 'play', previous: 'previous', next: 'next', previousPage: 'previous-page', nextPage: 'next-page', top: 'top', smaller: 'font-smaller', larger: 'font-larger', apply: 'apply'};
    const add = (key, label, primary = false) => {
      const button = element('button', 'preview-tool' + (primary ? ' preview-tool-primary' : ''), label);
      button.type = 'button';
      button.dataset.previewAction = identifiers[key];
      button.addEventListener('click', () => runPreviewCommand(identifiers[key]));
      previewButtons[key] = button;
      actions.append(button);
    };
    add('returnList', '返回目录');
    add('play', '预览试滚');
    add('previous', '上一段');
    add('next', '下一段');
    add('previousPage', '上一页');
    add('nextPage', '下一页');
    add('top', '回顶部');
    add('smaller', '字号 −');
    add('larger', '字号 +');
    add('apply', '应用到展示', true);
    previewToolbar.append(heading, actions);
    document.body.append(previewToolbar);
    new ResizeObserver(fitStage).observe(previewToolbar);
    updatePreviewToolbar();
    fitStage();
  }

  function animatePreview(timestamp) {
    requestAnimationFrame(animatePreview);
    if (!previewPlaying || isMediaMode() || isPagesMode() || !renderedSnapshot || positioning || previewVisibilityHold || document.visibilityState === 'hidden' || timestamp < manualHoldUntil) {
      previewLastFrame = null;
    } else {
      const elapsed = previewLastFrame == null ? 0 : Math.min((timestamp - previewLastFrame) / 1000, 0.12);
      previewLastFrame = timestamp;
      const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (scroll.scrollTop >= maxScroll - 1) setPreviewPlaying(false, 'interaction');
      else {
        previewFractionalDistance += clamp(previewLiveBinding?.speed ?? renderedSnapshot.layout?.speed, 5, 180, defaults.speed) * elapsed;
        if (previewFractionalDistance > 0) {
          reflowAnchor = null;
          clearPreviewSelection();
          const before = scroll.scrollTop;
          scroll.scrollTop = Math.min(maxScroll, before + previewFractionalDistance);
          // Retain the part the browser could not represent at this zoom level.
          previewFractionalDistance -= scroll.scrollTop - before;
        }
      }
    }
    // Send this frame's resulting position, rather than its previous position.
    publishPreviewMotion(timestamp);
  }

  async function renderPreview(snapshot, requestedAnchor, requestedPage) {
    const version = ++previewRenderVersion;
    previewLiveBinding = null;
    cancelPreviewResume();
    if(mediaPlayer&&mediaKey(renderedSnapshot))previewMediaPositions.set(mediaKey(renderedSnapshot),mediaPlayer.getState());
    const oldKey = previewContentKey(renderedSnapshot);
    const oldSelected = previewSelectedAnchor;
    if (isPagesMode() && pageElements.length) previewPagePositions.set(previewPagingKey(renderedSnapshot), pageIndex);
    if (oldKey) previewPositions.set(oldKey, currentAnchor());
    const newKey = previewContentKey(snapshot);
    const anchor = requestedAnchor !== undefined ? requestedAnchor : previewPositions.get(newKey) ?? null;
    const focusWasContent = !editorPreview && content.contains(document.activeElement);
    cancelPreviewPositionReport();
    setPreviewPlaying(false);
    clearPreviewSelection();
    previewAcknowledgedId = null;
    previewCanApply = false;
    previewStatusMessage = '正在准备预览…';
    renderSnapshot(snapshot);
    updatePreviewToolbar();
    const savedPage = requestedPage !== undefined ? requestedPage : previewPagePositions.get(previewPagingKey(snapshot));
    const restoring = restorePosition(anchor, false, savedPage);
    const restoreVersion = positionVersion;
    await restoring;
    if (version !== previewRenderVersion || snapshot.id !== snapshotId) return;
    if (positionVersion === restoreVersion && oldKey === newKey && oldSelected && anchorMap.has(oldSelected)) {
      previewSelectedAnchor = oldSelected;
      const selected = isPagesMode() ? [...(pageElements[pageIndex]?.querySelectorAll('[data-anchor]') || [])].find(node => node.dataset.anchor === oldSelected) : anchorMap.get(oldSelected);
      selected?.classList.add('preview-selected');
    }
    if(mediaPlayer){
      const player=mediaPlayer,saved=previewMediaPositions.get(mediaKey(snapshot));
      if(saved)await player.setState(saved,false,{remote:true});
      await player.whenCaptionReady();
      if(version!==previewRenderVersion||snapshot.id!==snapshotId||mediaPlayer!==player)return;
    }
    previewAcknowledgedId = snapshotId;
    previewStatusMessage = editorPreview ? '编辑预览已就绪 · 未保存 / 未上屏' : '预览已就绪 · 应用后更新展示';
    if (focusWasContent) {
      const heading = content.querySelector('h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({preventScroll: true});
      }
    }
    updatePreviewToolbar();
    window.parent.postMessage({type: 'wb-preview-rendered', snapshot_id: snapshotId}, location.origin);
    postPreviewPosition('render');
  }

  function recentLiveMotion() {
    return Boolean(!preview && liveMotion && state && liveMotion.snapshot_id === state.snapshot?.id &&
      liveMotion.revision === state.revision && performance.now() - liveMotion.received_at <= 250);
  }

  function applyLiveMotion() {
    if (!recentLiveMotion() || positioning) return;
    if(mediaPlayer){
      if(audienceMediaHold!==state.revision&&validMediaState(liveMotion.media_state)){mediaPlayer.setFollower?.(true);mediaPlayer.setState(liveMotion.media_state,Boolean(state.playing&&liveMotion.playing),{remote:true});}
      return;
    }
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (isPagesMode() && pageElements.length && Number.isInteger(liveMotion.page_index)) setCurrentPage(liveMotion.page_index);
    else scroll.scrollTop = Math.min(maxScroll, Math.max(0, liveMotion.scroll_top));
    setHoverAnchor(liveMotion.hover_anchor ?? null);
    setCategoryPeek(liveMotion.category_peek ?? null);
    reflowAnchor = null;
    lastFrame = null;
    fractionalDistance = 0;
    locallyAtEnd = false;
  }

  function receiveLiveMotion(message) {
    if (preview || !message || typeof message.snapshot_id !== 'string' ||
      !Number.isSafeInteger(message.revision) || message.revision < 0 ||
      !Number.isSafeInteger(message.seq) || message.seq < 0 ||
      !Number.isFinite(message.scroll_top) || message.scroll_top < 0 || message.scroll_top > 1e8 ||
      typeof message.playing !== 'boolean' || (message.category_peek != null && (typeof message.category_peek !== 'string' || !message.category_peek.startsWith('category:') || message.category_peek.length > 200)) || (message.hover_anchor != null && (typeof message.hover_anchor !== 'string' || message.hover_anchor.length > 250)) || (message.page_index != null && (!Number.isInteger(message.page_index) || message.page_index < 0 || message.page_index > 100000)) || !Number.isFinite(message.sent_at) ||
      Date.now() - message.sent_at > 500 || message.sent_at - Date.now() > 1000) return;
    const motion = {...message, received_at: performance.now()};
    if (state && message.revision < state.revision) return;
    if (state && message.revision === state.revision) {
      if (message.snapshot_id !== state.snapshot?.id || (liveMotion && message.seq <= liveMotion.seq) || !validCategoryPeek(message.category_peek, state.snapshot) || !validHoverAnchor(message.hover_anchor, state.snapshot)) return;
      liveMotion = motion;
      recordMotion(motionReceivedTimes);
      lastReceivedMotionWallTime = Date.now();
      applyLiveMotion();
      return;
    }
    const key = `${message.snapshot_id}:${message.revision}`;
    const previous = futureMotions.get(key);
    if (previous && message.seq <= previous.seq) return;
    futureMotions.set(key, motion);
    recordMotion(motionReceivedTimes);
    lastReceivedMotionWallTime = Date.now();
    for (const [entryKey, value] of futureMotions) {
      if (Date.now() - value.sent_at > 500) futureMotions.delete(entryKey);
    }
    while (futureMotions.size > 4) futureMotions.delete(futureMotions.keys().next().value);
  }

  function publishPreviewMotion(timestamp, force = false) {
    const binding = previewLiveBinding;
    if (preview && previewHiddenState && document.visibilityState !== 'hidden' && !previewVisibilityHold) requestAudiencePosition();
    if (!preview || !liveChannel || previewFeedback !== 'realtime' || !binding || positioning || previewVisibilityHold || document.visibilityState === 'hidden' ||
      binding.snapshot_id !== snapshotId || previewAcknowledgedId !== snapshotId) { motionScheduler.reset(); return; }
    // Video/audio clocks run locally; keep their correction channel independent.
    if (!motionScheduler.due(timestamp, mediaPlayer ? 10 : previewSyncRate, force)) return;
    const activityKey = JSON.stringify([scroll.scrollTop, categoryPeekId, hoverAnchor, pageIndex,
      mediaPlayer ? mediaPlayer.getState().caption_index : null]);
    if (activityKey !== motionActivityKey) { if (motionActivityKey) motionActivityAt = timestamp; motionActivityKey = activityKey; }
    recordMotion(motionSentTimes);
    // Timestamp-based, strictly increasing sequence numbers remain ordered
    // across rebindings and normal iframe reloads without a shared counter.
    previewMotionSeq = Math.max(previewMotionSeq + 1, Date.now() * 1000);
    liveChannel.postMessage({type: 'motion', snapshot_id: binding.live_snapshot_id,
      revision: binding.revision, seq: previewMotionSeq, scroll_top: scroll.scrollTop,
      playing: mediaPlayer?mediaPlayer.playing:previewPlaying, category_peek: categoryPeekId, hover_anchor: hoverAnchor, ...pageStatus(), sent_at: Date.now()});
  }

  function setPreviewLiveBinding(message) {
    if (message.enabled !== true) { previewLiveBinding = null; mediaPlayer?.setMuted(true,{locked:false});cancelPreviewResume(); return; }
    if (previewFeedback !== 'realtime' || !renderedSnapshot || message.snapshot_id !== snapshotId ||
      previewAcknowledgedId !== snapshotId || typeof message.live_snapshot_id !== 'string' ||
      !Number.isSafeInteger(message.revision) || message.revision < 0) return;
    if (previewLiveBinding && message.revision < previewLiveBinding.revision) return;
    const mediaNeedsSeek=!previewLiveBinding||message.seek_version!==previewLiveBinding.seek_version;
    advanceHiddenPrediction(message.playing, message.speed);
    previewLiveBinding = {snapshot_id: snapshotId, live_snapshot_id: message.live_snapshot_id,
      revision: message.revision, seek_version:message.seek_version, speed: clamp(message.speed, 5, 180, renderedSnapshot.layout?.speed || defaults.speed)};
    if(mediaPlayer){mediaPlayer.setMuted(true,{locked:true});if(mediaNeedsSeek&&validMediaState(message.media_state))mediaPlayer.setState(message.media_state,Boolean(message.playing),{remote:true});else mediaPlayer.setPlayback(Boolean(message.playing),{remote:true});previewPlaying=mediaPlayer.playing;}
    if (typeof message.playing === 'boolean' && message.playing !== previewPlaying) setPreviewPlaying(message.playing);
    motionScheduler.reset();
    if (document.visibilityState === 'hidden') rememberHiddenPosition();
    else if (previewVisibilityHold && (!previewResumePending || previewResumePending.revision !== message.revision || previewResumePending.snapshot_id !== message.live_snapshot_id)) requestAudiencePosition();
    publishPreviewMotion(performance.now(), true);
  }

  function followPreviewCommand(message) {
    if (!previewLiveBinding || previewFeedback !== 'realtime' || message.snapshot_id !== snapshotId ||
      previewAcknowledgedId !== snapshotId || !['seek', 'page','media'].includes(message.action) ||
      (message.action === 'seek' && message.anchor != null && !anchorMap.has(message.anchor)) ||
      (message.action === 'page' && (!isPagesMode() || !Number.isInteger(message.page_index)))) return;
    if(mediaPlayer&&message.action==='media'&&validMediaState(message.media_state)){mediaPlayer.setState(message.media_state,Boolean(message.playing),{remote:true});previewPlaying=mediaPlayer.playing;updatePreviewToolbar();postPreviewPosition('render');return;}
    cancelPreviewResume();
    cancelPreviewPositionReport();
    positionVersion += 1;
    positioning = false;
    reflowAnchor = null;
    clearPreviewSelection();
    if (typeof message.playing === 'boolean') setPreviewPlaying(message.playing);
    if (Number.isFinite(message.speed)) previewLiveBinding.speed = clamp(message.speed, 5, 180, defaults.speed);
    previewSelectedAnchor = message.anchor ?? null;
    if (previewSelectedAnchor) anchorMap.get(previewSelectedAnchor)?.classList.add('preview-selected');
    if (message.action === 'page') { clearPreviewSelection(); setCurrentPage(message.page_index); }
    else placeAnchor(message.anchor ?? null);
    updatePreviewToolbar();
    publishPreviewMotion(performance.now(), true);
    postPreviewPosition('render');
  }

  function cancelPreviewResume() {
    clearTimeout(previewResumeTimer);
    previewResumePending = null;
    previewHiddenState = null;
    previewVisibilityHold = false;
  }

  function rememberHiddenPosition() {
    if (!preview || !previewLiveBinding || previewHiddenState) return;
    previewHiddenState = {scroll_top: scroll.scrollTop, playing: previewPlaying,
      speed: previewLiveBinding.speed, at: Date.now(), ...pageStatus()};
    previewLastFrame = null;
    previewFractionalDistance = 0;
  }

  function advanceHiddenPrediction(playing, speed) {
    if (!previewHiddenState) return;
    const elapsed = Math.max(0, (Date.now() - previewHiddenState.at) / 1000);
    if (previewHiddenState.playing&&!mediaPlayer) previewHiddenState.scroll_top += elapsed * previewHiddenState.speed;
    previewHiddenState.at = Date.now();
    if (typeof playing === 'boolean') previewHiddenState.playing = playing;
    if (Number.isFinite(speed)) previewHiddenState.speed = clamp(speed, 5, 180, defaults.speed);
  }

  function finishAudienceResume(position) {
    if (!previewVisibilityHold || !previewLiveBinding) return;
    cancelPreviewPositionReport();
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    clearPreviewSelection();
    if(mediaPlayer&&validMediaState(position.media_state))mediaPlayer.setState(position.media_state,Boolean(position.playing),{remote:true});
    if (isPagesMode() && Number.isInteger(position.page_index)) setCurrentPage(position.page_index);
    else scroll.scrollTop = Math.max(0, Math.min(maxScroll, position.scroll_top));
    if (Number.isFinite(position.speed)) previewLiveBinding.speed = clamp(position.speed, 5, 180, defaults.speed);
    setPreviewPlaying(position.playing);
    cancelPreviewResume();
    motionScheduler.reset();
    publishPreviewMotion(performance.now(), true);
    postPreviewPosition('render');
  }

  function requestAudiencePosition() {
    if (!previewLiveBinding || previewFeedback !== 'realtime' || document.visibilityState === 'hidden') return;
    previewVisibilityHold = true;
    previewLastFrame = null;
    clearTimeout(previewResumeTimer);
    const binding = previewLiveBinding;
    const request = {type: 'position-request', request_id: `${previewResumeClient}:${++previewResumeSeq}`,
      snapshot_id: binding.live_snapshot_id, revision: binding.revision};
    previewResumePending = request;
    // Install the timeout first: an in-process test/channel may answer immediately.
    previewResumeTimer = setTimeout(() => {
      if (previewResumePending !== request || !previewHiddenState) return;
      advanceHiddenPrediction();
      finishAudienceResume(mediaPlayer?{...previewHiddenState,media_state:mediaPlayer.getState(),playing:mediaPlayer.playing}:previewHiddenState);
    }, 800);
    if (liveChannel) liveChannel.postMessage(request);
  }

  function receiveAudiencePosition(message) {
    const pending = previewResumePending;
    const binding = previewLiveBinding;
    if (!previewVisibilityHold || !pending || !binding || document.visibilityState === 'hidden' ||
      message.request_id !== pending.request_id || message.snapshot_id !== pending.snapshot_id ||
      message.revision !== pending.revision || message.snapshot_id !== binding.live_snapshot_id ||
      message.revision !== binding.revision || !Number.isFinite(message.scroll_top) ||
      message.scroll_top < 0 || message.scroll_top > 1e8 || typeof message.playing !== 'boolean' ||
      !Number.isFinite(message.speed) || !Number.isFinite(message.sent_at) ||
      Date.now() - message.sent_at > 1000 || message.sent_at - Date.now() > 1000) return;
    finishAudienceResume(message);
  }

  async function replyAudiencePosition(message) {
    if (preview || !liveChannel || !state || typeof message.request_id !== 'string' || message.request_id.length > 120 ||
      message.snapshot_id !== state.snapshot?.id || message.revision !== state.revision) return;
    const deadline = performance.now() + 500;
    while (!document.hidden && positioning && performance.now() < deadline) await nextFrame();
    if (!liveChannel || positioning || message.snapshot_id !== state.snapshot?.id || message.revision !== state.revision) return;
    liveChannel.postMessage({type: 'position-report', request_id: message.request_id,
      snapshot_id: message.snapshot_id, revision: message.revision, scroll_top: scroll.scrollTop,
      playing: mediaPlayer?mediaPlayer.playing:Boolean(state.playing), speed: clamp(state.speed, 5, 180, defaults.speed), ...pageStatus(), sent_at: Date.now()});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Also release waits that began just before the window was minimized.
      for (const finish of [...pendingLayoutFrames]) finish();
      if (contentTransition) { contentTransition.cancel(); contentTransition = null; }
    }
    if (!preview) {
      lastFrame = document.hidden ? performance.now() : null;
      if (!document.hidden) { fitStage(); poll(); }
      reportDisplayHealth();
      return;
    }
    if (document.visibilityState === 'hidden') {
      if (previewVisibilityHold) {
        clearTimeout(previewResumeTimer);
        previewResumePending = null;
        previewVisibilityHold = false;
      }
      rememberHiddenPosition();
    } else if (previewLiveBinding && previewHiddenState) requestAudiencePosition();
  });

  if (liveChannel) liveChannel.addEventListener('message', event => {
    if (preview) {
      if (event.data?.type === 'position-report') receiveAudiencePosition(event.data);
      return;
    }
    if (event.data?.type === 'display-health-request') { reportDisplayHealth(); return; }
    if (event.data?.type === 'page-step' || event.data?.type === 'page-status-request') { replyPageRequest(event.data); return; }
    if (event.data?.type === 'position-request') { replyAudiencePosition(event.data); return; }
    if (event.data?.type === 'state') {
      const next = event.data.state;
      if (next && Number.isSafeInteger(next.revision) && next.revision >= 0 &&
        (next.snapshot == null || (typeof next.snapshot.id === 'string' && Array.isArray(next.snapshot.scripts)))) acceptState(next);
    } else if (event.data?.type === 'motion') receiveLiveMotion(event.data);
  });
  window.addEventListener('pagehide', () => {
    reportDisplayHealth('closed');
    previewLiveBinding = null;
    cancelPreviewResume();
    if (liveChannel) { liveChannel.close(); liveChannel = null; }
  });

  async function connect() {
    if (preview || connecting || connected) return;
    connecting = true;
    try {
      const initial = await api('/api/display/connect', {});
      connected = true;
      acceptState(initial);
    } catch (_) {
      setDisconnected();
    } finally {
      connecting = false;
      reportDisplayHealth();
    }
  }

  async function poll() {
    if (preview || polling) return;
    if (!connected) {
      await connect();
      return;
    }
    polling = true;
    try {
      acceptState(await api('/api/state', undefined, {method: 'GET'}));
      if (locallyAtEnd && state?.playing && !bottomRequest) pauseAtEnd();
    } catch (_) {
      setDisconnected();
    } finally {
      polling = false;
      reportDisplayHealth();
    }
  }

  document.fonts?.addEventListener?.('loadingdone', refreshPagination);
  new ResizeObserver(fitStage).observe(viewport);
  window.addEventListener('resize', fitStage);
  scroll.addEventListener('wheel', manualIntent, {passive: true});
  scroll.addEventListener('touchstart', manualIntent, {passive: true});
  scroll.addEventListener('pointerdown', manualIntent, {passive: true});
  window.addEventListener('keydown', manualIntent);
  scroll.addEventListener('scroll', () => {
    positionCategoryPeek();
    if (preview) {
      if (previewManualScrollPending && !positioning) schedulePreviewPositionReport();
      return;
    }
    if (!positioning && !recentLiveMotion()) scheduleCheckpoint();
  }, {passive: true});

  if (preview) {
    document.body.classList.add('preview-mode');
    renderSnapshot(null);
    createPreviewToolbar();
    window.addEventListener('keydown', previewKeydown);
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.type === 'wb-editor-focus') {
        focusEditorAnchor(event.data);
        return;
      }
      if (event.data?.type === 'wb-preview-live-binding') {
        if (editorPreview) return;
        setPreviewLiveBinding(event.data);
        return;
      }
      if (event.data?.type === 'wb-preview-follow-command') {
        if (editorPreview) return;
        followPreviewCommand(event.data);
        return;
      }
      if (event.data?.type === 'wb-preview-options') {
        setPreviewOptions(editorPreview ? {...event.data, feedback: 'confirm'} : event.data);
        return;
      }
      if (event.data?.type === 'wb-preview-key') {
        if (!renderedSnapshot || event.data.snapshot_id !== snapshotId) return;
        runPreviewKey(event.data.key);
        return;
      }
      if (event.data?.type === 'wb-preview-command') {
        if (!renderedSnapshot || event.data.snapshot_id !== snapshotId) return;
        runPreviewCommand(event.data.action);
        return;
      }
      if (event.data?.type === 'wb-preview-position-request') {
        if (!renderedSnapshot || event.data.snapshot_id !== snapshotId || previewAcknowledgedId !== snapshotId) return;
        postPreviewPosition('render');
        return;
      }
      if (event.data?.type === 'wb-preview-apply-request') {
        if (editorPreview) return;
        if (event.data.snapshot_id !== snapshotId) return;
        applyPreview();
        return;
      }
      if (event.data?.type === 'wb-preview-status') {
        if (event.data.snapshot_id !== snapshotId) return;
        previewCanApply = !editorPreview && event.data.can_apply === true;
        previewStatusMessage = text(event.data.message) || '预览草稿';
        updatePreviewToolbar();
        return;
      }
      if (event.data?.type !== 'wb-preview') return;
      const snapshot = event.data.snapshot;
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.scripts)) return;
      if ((snapshot.id || null) === snapshotId) {
        if (previewAcknowledgedId === snapshotId) {
          window.parent.postMessage({type: 'wb-preview-rendered', snapshot_id: snapshotId}, location.origin);
          postPreviewPosition('render');
          previewToolsKey = '';
          updatePreviewToolbar();
        }
        return;
      }
      renderPreview(snapshot, event.data.anchor, event.data.page_index);
    });
    window.parent.postMessage({type: 'wb-preview-ready'}, location.origin);
    requestAnimationFrame(animatePreview);
    setInterval(reportPreviewSync, 500);
    return; // Preview scrolling is local; no connect, poll, or checkpoint calls.
  }

  // Bootstrap can render instantly, but never starts scrolling before the
  // server has acknowledged this newly opened audience window as paused.
  renderSnapshot(bootstrap.state?.snapshot || null);
  connect();
  setInterval(poll, 700);
  // Browsers may throttle this too. It keeps logical progress moving when allowed,
  // but cannot make Windows window capture paint a minimized browser.
  setInterval(() => {
    const now = performance.now();
    if (document.hidden || now - lastAudiencePaint > 500) advanceAudience(now, true);
  }, 250);
  setInterval(() => checkpoint(), 2000);
  requestAnimationFrame(animate);
  window.addEventListener('pagehide', () => {
    clearTimeout(checkpointTimer);
    checkpoint({keepalive: true});
  });
})();
