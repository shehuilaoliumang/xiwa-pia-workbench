(() => {
  'use strict';
  const EPS = .006, DRIFT = .35;
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const color = value => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value || '') ? value : '';
  function readableColor(value, fallback = '#40382E') {
    if (!color(value)) return fallback;
    const expanded = value.length === 4 ? '#' + [...value.slice(1)].map(channel => channel + channel).join('') : value;
    let rgb = [1, 3, 5].map(index => parseInt(expanded.slice(index, index + 2), 16));
    const luminance = channels => channels.map(channel => {
      const fraction = channel / 255;
      return fraction <= .04045 ? fraction / 12.92 : ((fraction + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    // Match the main reader's light canvas while preserving the source hue.
    for (let attempt = 0; attempt < 6 && (.92 + .05) / (luminance(rgb) + .05) < 4.5; attempt++) {
      rgb = rgb.map(channel => Math.round(channel * .75));
    }
    return '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('');
  }
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = String(text);
    return item;
  };
  const clock = seconds => {
    const value = Math.max(0, Math.floor(number(seconds))), hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
    return (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) + ':' + String(value % 60).padStart(2, '0');
  };
  function localUrl(path) {
    if (!String(path || '').trim()) return '';
    try {
      const url = new URL(String(path), location.href);
      return url.origin === location.origin && ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  let captionPaginationModule;
  class PiaMediaPlayer {
    constructor({container, script, layout = {}, preview = false, onChange = () => {}}) {
      if (!(container instanceof HTMLElement)) throw new TypeError('媒体播放器需要一个页面容器。');
      this.container = container; this.script = script || {}; this.layout = layout;
      this.preview = Boolean(preview); this.onChange = typeof onChange === 'function' ? onChange : () => {};
      this.blocks = Array.isArray(this.script.blocks) ? this.script.blocks : [];
      this.blockMap = new Map(this.blocks.map(block => [String(block.id), block]));
      this.cues = (Array.isArray(this.script.media?.cues) ? this.script.media.cues : [])
        .filter(cue => Number.isFinite(Number(cue.at)) && Number(cue.at) >= 0)
        .map((cue, index) => ({id: String(cue.id || 'cue-' + index), at: Number(cue.at), label: String(cue.label || ''),
          block_ids: [...new Set(Array.isArray(cue.block_ids) ? cue.block_ids.map(String) : [])]}))
        .sort((left, right) => left.at - right.at);
      this._captionIndex = 0; this._cueId = null; this._consumed = new Set();
      this._captionPageIndex = 0; this._captionPages = []; this._captionRenderVersion = 0;
      this._captionReadyPromise = Promise.resolve(); this._captionResizeTimer = 0; this._captionMeasureKey = '';
      this._captionPagingFailed = false;
      this._captionDestroyedPromise = new Promise(resolve => { this._resolveCaptionDestroyed = resolve; });
      this._waitingAtCue = false; this._follower = false; this._followerUntil = 0; this._followerTimer = 0;
      this._destroyed = false; this._mutedLocked = false;
      this._playVersion = 0; this._playPromise = null; this._ignorePlayEvents = 0; this._ignorePauseEvents = 0;
      this._raf = 0; this._cueTimer = 0; this._pendingPosition = null; this._scrubbing = false;
      this._ended = false; this._error = ''; this._blocked = false; this._listeners = [];
      this._build(); this._listen(); this._renderCaption(); this._refreshUI();
      this._captionObserver = new ResizeObserver(() => this._scheduleCaptionLayout());
      this._captionObserver.observe(this.captionScroll);
      if(document.fonts?.addEventListener)this._on(document.fonts,'loadingdone',()=>this._scheduleCaptionLayout(true));
      const source = localUrl(this.script.media?.path);
      if (!source) this._fail('媒体地址无效，请重新选择本地媒体文件。');
      else { this.media.src = source; this.media.load(); }
    }
    get playing() { return !this._destroyed && !this.media.paused && !this.media.ended; }
    get duration() {
      return Number.isFinite(this.media.duration) && this.media.duration > 0 ? this.media.duration : Math.max(0, number(this.script.media?.duration));
    }
    get captionMode() { return this.layout.media_caption_mode === 'manual' ? 'manual' : 'auto'; }
    get groupCount() { return this.cues.length || this.blocks.length; }
    get captionLayout() { return this.layout.media_caption_layout === 'scroll' ? 'scroll' : 'pages'; }
    get captionPageIndex() { return this._captionPageIndex; }
    get captionPageCount() { return this.captionLayout === 'scroll' || this._captionPagingFailed ? (this.groupCount ? 1 : 0) : this._captionPages.length; }
    async whenCaptionReady() {
      while(!this._destroyed){const pending=this._captionReadyPromise;await Promise.race([pending,this._captionDestroyedPromise]);if(pending===this._captionReadyPromise)return;}
    }
    getState() {
      return {position: Math.round(Math.max(0, number(this.media.currentTime)) * 1000) / 1000,
        caption_index: this._captionIndex, caption_page_index: this._captionPageIndex, cue_id: this._cueId};
    }
    _button(action, text, label) {
      const button = node('button', 'pia-media-button', text);
      button.type = 'button'; button.dataset.mediaAction = action; button.setAttribute('aria-label', label);
      return button;
    }
    _build() {
      this.root = node('div', 'pia-media-player');
      this.root.dataset.mediaSide = this.layout.media_side === 'right' ? 'right' : 'left';
      this.root.dataset.captionMode = this.captionMode;
      this.root.dataset.captionLayout = this.captionLayout;
      this.root.dataset.mediaKind = this.script.media?.kind === 'audio' ? 'audio' : 'video';
      this.root.style.setProperty('--pia-caption-font', clamp(number(this.layout.font_size, 34), 16, 96) + 'px');
      this.root.style.setProperty('--pia-caption-line', clamp(number(this.layout.line_height, 1.7), 1.1, 3));
      this.root.style.setProperty('--pia-caption-padding', clamp(number(this.layout.padding, 56) * .4, 18, 48) + 'px');
      this.visual = node('section', 'pia-media-visual'); this.visual.setAttribute('aria-label', '媒体画面');
      this.media = document.createElement(this.root.dataset.mediaKind === 'audio' ? 'audio' : 'video');
      this.media.className = 'pia-media-element'; this.media.preload = 'metadata'; this.media.playsInline = true;
      this.media.controls = false; this.media.muted = this.preview;
      this.media.setAttribute('aria-label', String(this.script.media?.name || '剧本媒体')); this.visual.append(this.media);
      if (this.root.dataset.mediaKind === 'audio') {
        const art = node('div', 'pia-media-audio-art');
        art.append(node('span', 'pia-media-audio-symbol', '♪'), node('p', 'pia-media-audio-name', this.script.media?.name || '音频走本'));
        this.visual.append(art);
      }
      this.status = node('p', 'pia-media-status', '正在加载媒体…');
      this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.visual.append(this.status);
      this.controls = node('div', 'pia-media-controls');
      this.controls.setAttribute('role', 'group'); this.controls.setAttribute('aria-label', '媒体播放控制');
      this.playButton = this._button('play', '播放', '播放或暂停媒体'); this.muteButton = this._button('mute', '', '切换媒体声音');
      const buttons = node('div', 'pia-media-button-row'); buttons.append(this.playButton, this.muteButton);
      this.time = node('output', 'pia-media-time'); this.time.setAttribute('aria-label', '当前时间和媒体时长'); buttons.append(this.time);
      this.progress = document.createElement('input'); this.progress.type = 'range';
      this.progress.min = '0'; this.progress.max = String(this.duration || 1); this.progress.step = '.01'; this.progress.value = '0';
      this.progress.className = 'pia-media-progress'; this.progress.setAttribute('aria-label', '媒体进度');
      this.controls.append(buttons, this.progress); this.visual.append(this.controls);
      this.captions = node('section', 'pia-media-captions'); this.captions.setAttribute('aria-label', '走本台词');
      const heading = node('header', 'pia-media-caption-heading'); this.captionLabel = node('span', 'pia-media-caption-label');
      this.previousButton = this._button('previous-caption', '上一组', '上一组台词');
      this.nextButton = this._button('next-caption', '下一组', '下一组台词');
      const navigation = node('div', 'pia-media-caption-navigation'); navigation.append(this.previousButton, this.nextButton);
      heading.append(this.captionLabel, navigation);
      this.captionScroll = node('div', 'pia-media-caption-scroll'); this.captionScroll.tabIndex = 0;
      this.captionScroll.setAttribute('role', 'region'); this.captionScroll.setAttribute('aria-label', '当前台词内容');
      this.captionPageNavigation=node('nav','pia-media-page-navigation');this.captionPageNavigation.setAttribute('aria-label','台词组内翻页');
      this.previousPageButton=this._button('previous-caption-page','上一页','上一页台词');this.nextPageButton=this._button('next-caption-page','下一页','下一页台词');
      this.captionPageLabel=node('output','pia-media-page-label');this.captionPageLabel.setAttribute('aria-live','polite');
      this.captionPageNavigation.append(this.previousPageButton,this.captionPageLabel,this.nextPageButton);
      this.captions.append(heading, this.captionScroll, this.captionPageNavigation); this.root.append(this.visual, this.captions); this.container.append(this.root);
    }
    _on(target, type, listener) { target.addEventListener(type, listener); this._listeners.push([target, type, listener]); }
    _listen() {
      this._on(this.playButton, 'click', () => this.playing ? this.pause() : void this.play());
      this._on(this.muteButton, 'click', () => { if (!this._mutedLocked) this.setMuted(!this.media.muted); });
      this._on(this.previousPageButton,'click',()=>this.previousCaptionPage());this._on(this.nextPageButton,'click',()=>this.nextCaptionPage());
      this._on(this.previousButton, 'click', () => this.previousCaption()); this._on(this.nextButton, 'click', () => this.nextCaption());
      this._on(this.progress, 'pointerdown', () => { this._scrubbing = true; this.pause(); });
      this._on(this.progress, 'input', () => {
        if (!this._scrubbing) { this._scrubbing = true; this.pause(); }
        this._seekElement(number(this.progress.value)); this._refreshProgress();
      });
      const commit = () => { if (this._scrubbing) { this._scrubbing = false; this.seek(number(this.progress.value)); } };
      this._on(this.progress, 'change', commit); this._on(this.progress, 'pointerup', commit); this._on(this.progress, 'pointercancel', commit);
      this._on(this.media, 'loadedmetadata', () => {
        if (this._pendingPosition !== null) { const position = this._pendingPosition; this._pendingPosition = null; this._seekElement(position); }
        this._error = ''; this._refreshUI();
      });
      this._on(this.media, 'durationchange', () => this._refreshProgress());
      this._on(this.media, 'canplay', () => { if (!this._error) this._refreshUI(); });
      this._on(this.media, 'timeupdate', () => { this._checkCue(); this._refreshProgress(); });
      this._on(this.media, 'play', () => {
        const expected = this._ignorePlayEvents > 0; if (expected) this._ignorePlayEvents--;
        this._startClock(); this._refreshUI(); if (!expected) this._emit('play');
      });
      this._on(this.media, 'pause', () => {
        const expected = this._ignorePauseEvents > 0; if (expected) this._ignorePauseEvents--;
        this._stopClock(); this._refreshUI(); if (!expected && !this.media.ended) this._emit('pause');
      });
      this._on(this.media, 'ended', () => {
        this._ended = true; this._waitingAtCue = false; this._stopClock(); this._refreshUI(); this._emit('ended');
      });
      this._on(this.media, 'error', () => this._fail('媒体无法加载，请检查文件是否存在、格式是否可播放。'));
      this._on(this.media, 'volumechange', () => this._refreshUI());
    }
    _pauseElement() {
      ++this._playVersion; this._playPromise = null;
      if (!this.media.paused) { this._ignorePauseEvents++; this.media.pause(); }
      this._stopClock();
    }
    _seekElement(seconds) {
      const position = clamp(number(seconds), 0, this.duration || Math.max(0, number(seconds)));
      try { this.media.currentTime = position; } catch { this._pendingPosition = position; }
      if (this.media.readyState === 0) this._pendingPosition = position;
    }
    _setConsumed(cueId, position, rewind = false) {
      const index = this.cues.findIndex(cue => cue.id === cueId), previous = this.cues.findIndex(cue => cue.id === this._cueId);
      if (!rewind && index < previous && Math.abs(position - this.media.currentTime) <= DRIFT) return;
      this._cueId = index >= 0 ? this.cues[index].id : null;
      this._consumed = new Set(this.cues.slice(0, index + 1).map(cue => cue.id));
    }
    _nextCue() { return this.cues.find(cue => !this._consumed.has(cue.id)); }
    _isFollower() {
      if (this._follower && performance.now() >= this._followerUntil) this._follower = false;
      return this._follower;
    }
    _checkCue(force = false) {
      if (this._destroyed || this._isFollower() || this._scrubbing || (!force && !this.playing)) return false;
      const cue = this._nextCue(); if (!cue || this.media.currentTime + EPS < cue.at) return false;
      this._consumed.add(cue.id); this._cueId = cue.id; this._waitingAtCue = true; this._ended = false;
      this._pauseElement(); this._seekElement(cue.at);
      if (this.captionMode === 'auto') this._setCaption(this.cues.indexOf(cue), false);
      this._refreshUI(); this._emit('cue'); return true;
    }
    _scheduleCue() {
      clearTimeout(this._cueTimer); this._cueTimer = 0; const cue = this._nextCue();
      if (this._isFollower() || !this.playing || !cue) return;
      const wait = Math.max(8, (cue.at - this.media.currentTime) / Math.max(.1, this.media.playbackRate || 1) * 1000);
      this._cueTimer = setTimeout(() => { this._cueTimer = 0; if (!this._checkCue()) this._scheduleCue(); }, Math.min(wait, 2147483647));
    }
    _startClock() {
      if (this._destroyed) return; this._scheduleCue(); if (this._raf) return;
      const tick = () => {
        this._raf = 0; if (this._destroyed || !this.playing) return;
        this._checkCue(); this._refreshProgress(); if (this.playing) this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    _stopClock() {
      if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
      clearTimeout(this._cueTimer); this._cueTimer = 0;
    }
    async play({remote = false} = {}) {
      if (this._destroyed || this._error) return false;
      if (this.playing) { this._startClock(); return true; } if (this._playPromise) return this._playPromise;
      if (this._ended || (this.duration > 0 && this.media.currentTime >= this.duration - EPS)) {
        this._ended = false; this._waitingAtCue = false; this._consumed.clear(); this._cueId = null;
        this._seekElement(0); if (this.captionMode === 'auto') this._setCaption(0, false);
      }
      if (this._checkCue(true)) return false;
      this._waitingAtCue = false; this._blocked = false; this._refreshUI();
      const version = ++this._playVersion; this._ignorePlayEvents++;
      let promise; try { promise = this.media.play(); } catch (failure) { promise = Promise.reject(failure); }
      this._playPromise = Promise.resolve(promise).then(() => {
        if (this._destroyed || version !== this._playVersion) return false;
        this._playPromise = null; this._refreshUI(); this._startClock(); if (!remote) this._emit('play'); return this.playing;
      }).catch(() => {
        if (this._destroyed || version !== this._playVersion) return false;
        this._ignorePlayEvents = Math.max(0, this._ignorePlayEvents - 1); this._playPromise = null;
        this._pauseElement(); this._blocked = true; this._refreshUI(); this._emit('blocked'); return false;
      });
      return this._playPromise;
    }
    pause({remote = false} = {}) {
      if (this._destroyed) return;
      const changed = this.playing || Boolean(this._playPromise);
      this._pauseElement(); this._refreshUI(); if (changed && !remote) this._emit('pause');
    }
    setPlayback(playing, options = {}) { return playing ? this.play(options) : this.pause(options); }
    seek(seconds, {remote = false} = {}) {
      if (this._destroyed) return;
      const target = clamp(number(seconds), 0, this.duration || Math.max(0, number(seconds)));
      this._pauseElement(); this._scrubbing = false; this._waitingAtCue = false; this._ended = false; this._blocked = false;
      this._seekElement(target);
      const passed = target <= EPS ? [] : this.cues.filter(cue => cue.at <= target + EPS);
      this._consumed = new Set(passed.map(cue => cue.id)); this._cueId = passed.at(-1)?.id || null;
      if (this.captionMode === 'auto' && this.cues.length) this._setCaption(Math.max(0, this.cues.findIndex(cue => cue.id === this._cueId)), false);
      this._refreshUI(); if (!remote) this._emit('seek');
    }
    async setState(mediaState = {}, playing = false, {remote = false} = {}) {
      if (this._destroyed) return this.getState();
      const position = clamp(number(mediaState.position, this.media.currentTime), 0, this.duration || Math.max(0, number(mediaState.position)));
      const drift = position - this.media.currentTime, rewind = drift < -DRIFT;
      // A lagging sender cannot undo a cue pause before acknowledging that cue.
      if (remote && this._waitingAtCue && mediaState.cue_id !== this._cueId && Math.abs(drift) <= DRIFT) {
        this._refreshUI(); return this.getState();
      }
      if (Math.abs(drift) > DRIFT) { this._seekElement(position); this._ended = false; this._waitingAtCue = false; }
      this._setConsumed(mediaState.cue_id ?? null, position, rewind);
      if (Number.isFinite(Number(mediaState.caption_index))) this._setCaption(Number(mediaState.caption_index), false);
      this._setCaptionPage(Math.max(0,Math.trunc(number(mediaState.caption_page_index,0))),false);
      if (playing) await this.play({remote}); else this.pause({remote});
      this._refreshUI(); return this.getState();
    }
    setMuted(value, options = {}) {
      if (this._destroyed) return;
      if (Object.prototype.hasOwnProperty.call(options, 'locked')) this._mutedLocked = Boolean(options.locked);
      this.media.muted = Boolean(value); this._refreshUI();
    }
    setFollower(value) {
      if (this._destroyed) return;
      clearTimeout(this._followerTimer); this._followerTimer = 0; this._follower = Boolean(value);
      if (this._follower) {
        this._followerUntil = performance.now() + 350;
        clearTimeout(this._cueTimer); this._cueTimer = 0;
        // Timers release a background follower when its rAF no longer runs.
        this._followerTimer = setTimeout(() => { this._followerTimer = 0; this.setFollower(false); }, 350);
      }
      else if (this.playing && !this._checkCue()) this._scheduleCue();
    }
    nextCaption() { this._setCaption(this._captionIndex + 1, true); }
    previousCaption() { this._setCaption(this._captionIndex - 1, true); }
    _setCaption(index, notify) {
      if (this._destroyed) return;
      const next = clamp(Math.trunc(number(index)), 0, Math.max(0, this.groupCount - 1));
      if (next === this._captionIndex) return;
      this._captionIndex = next; this._captionPageIndex = 0; this._renderCaption(); this._refreshUI(); if (notify) this._emit('caption');
    }
    _block(block) {
      const wrapper = node(block.kind === 'image' ? 'figure' : 'div', 'pia-media-block'); wrapper.dataset.blockId = String(block.id);
      if (block.kind === 'image') {
        const source = localUrl(block.image_path);
        if (source) { const image = document.createElement('img'); image.src = source; image.alt = block.text || '剧本原图'; wrapper.append(image); }
        return wrapper;
      }
      if (block.role) wrapper.append(node('span', 'pia-media-role', block.role));
      const text = node('div', 'pia-media-block-text'); if (color(block.color)) text.style.color = readableColor(block.color);
      if (Array.isArray(block.runs) && block.runs.map(run => run.text || '').join('') === String(block.text || '')) {
        for (const run of block.runs) { const span = node('span', '', run.text || ''); if (color(run.color)) span.style.color = readableColor(run.color); text.append(span); }
      } else text.textContent = block.text || '';
      wrapper.append(text); return wrapper;
    }
    nextCaptionPage() { this._setCaptionPage(this._captionPageIndex + 1, true); }
    previousCaptionPage() { this._setCaptionPage(this._captionPageIndex - 1, true); }
    _setCaptionPage(index, notify) {
      if(this._destroyed)return;
      const next=this.captionLayout==='scroll'||this._captionPagingFailed?0:this._captionPages.length
        ?clamp(Math.trunc(number(index)),0,this._captionPages.length-1):Math.max(0,Math.trunc(number(index)));
      const changed=next!==this._captionPageIndex;this._captionPageIndex=next;
      this._captionPages.forEach((page,number)=>{page.hidden=number!==next;page.classList.toggle('is-current',number===next);});
      if(this.captionLayout==='pages'&&!this._captionPagingFailed)this.captionScroll.scrollTop=0;this._refreshCaptionPages();
      if(changed&&notify&&this._captionPages.length)this._emit('caption-page');
    }
    _refreshCaptionPages() {
      if(this._destroyed)return;
      const paged=this.captionLayout==='pages'&&!this._captionPagingFailed,count=this.captionPageCount;
      this.captionPageNavigation.hidden=!paged;
      this.previousPageButton.disabled=!paged||!count||this._captionPageIndex<=0;
      this.nextPageButton.disabled=!paged||!count||this._captionPageIndex>=count-1;
      this.captionPageLabel.textContent=count?`第 ${this._captionPageIndex+1} / ${count} 页`:'正在分页…';
    }
    _captionDimensions() {
      const style=getComputedStyle(this.captionScroll);
      return {width:Math.max(0,this.captionScroll.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)),
        height:Math.max(0,this.captionScroll.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))};
    }
    _scheduleCaptionLayout(force=false) {
      if(this._destroyed||this.captionLayout!=='pages')return;
      const size=this._captionDimensions(),key=size.width+':'+size.height;
      if(!force&&key===this._captionMeasureKey)return;
      clearTimeout(this._captionResizeTimer);
      this._captionResizeTimer=setTimeout(()=>{if(!this._destroyed)this._renderCaption();},60);
    }
    _renderCaption() {
      const version=++this._captionRenderVersion,cue=this.cues[this._captionIndex];
      const blocks=this.cues.length?(cue?.block_ids||[]).map(id=>this.blockMap.get(id)).filter(Boolean):this.blocks[this._captionIndex]?[this.blocks[this._captionIndex]]:[];
      const source=node('div');source.append(...blocks.map(block=>this._block(block)));
      if(!blocks.length)source.append(node('p','pia-media-caption-empty',this.cues.length?'此时间点未关联台词。':'暂无正文台词。'));
      this.captionLabel.textContent=this.groupCount?'台词组 '+(this._captionIndex+1)+' / '+this.groupCount+(cue?.label?' · '+cue.label:''):'台词';
      this._captionPages=[];this._captionPagingFailed=false;this.root.dataset.captionLayout=this.captionLayout;
      this.captionScroll.scrollTop=0;this._refreshCaptionPages();
      if(this.captionLayout==='scroll'){
        this._captionPageIndex=0;this.captionScroll.replaceChildren(...source.childNodes);this._captionReadyPromise=Promise.resolve();return;
      }
      this.captionScroll.replaceChildren(node('p','pia-media-caption-loading','正在排版台词…'));
      this._captionReadyPromise=this._paginateCaption(source,version);
    }
    async _paginateCaption(source,version) {
      try{
        captionPaginationModule ||= import('/static/media-pagination.js');
        const module=await captionPaginationModule;
        if(document.fonts?.ready)await document.fonts.ready;
        await Promise.all([...source.querySelectorAll('img')].map(image=>image.decode?.().catch(()=>{})||Promise.resolve()));
        if(this._destroyed||version!==this._captionRenderVersion)return;
        const size=this._captionDimensions();this._captionMeasureKey=size.width+':'+size.height;
        if(size.width<1||size.height<1)return; // A hidden host will trigger its ResizeObserver when shown.
        this._captionPages=module.paginateCaptions(source,this.captionScroll,size.width,size.height);
        this.captionScroll.replaceChildren(...this._captionPages);
        this._setCaptionPage(this._captionPageIndex,false);
        this._emit('caption-layout');
      }catch(error){
        if(this._destroyed||version!==this._captionRenderVersion)return;
        this._captionPagingFailed=true;this._captionPageIndex=0;this._captionPages=[];this.root.dataset.captionLayout='scroll';
        const notice=node('p','pia-media-caption-notice','当前台词区域暂时无法分页，已显示完整可滚动台词。');notice.setAttribute('role','status');
        this.captionScroll.replaceChildren(notice,...source.childNodes);this._refreshCaptionPages();this._emit('caption-layout');
      }
    }
    _refreshProgress() {
      if (this._destroyed) return; const position = Math.max(0, number(this.media.currentTime));
      this.progress.max = String(this.duration || 1); if (!this._scrubbing) this.progress.value = String(position);
      this.progress.disabled = this.duration <= 0 || Boolean(this._error);
      this.time.textContent = clock(position) + ' / ' + (this.duration ? clock(this.duration) : '--:--');
      this.progress.setAttribute('aria-valuetext', clock(position) + '，总长 ' + (this.duration ? clock(this.duration) : '未知'));
    }
    _refreshUI() {
      if (this._destroyed) return;
      this.root.classList.toggle('is-playing', this.playing); this.root.classList.toggle('is-waiting', this._waitingAtCue);
      this.root.classList.toggle('is-blocked', this._blocked); this.root.classList.toggle('has-error', Boolean(this._error));
      this.playButton.textContent = this.playing ? '暂停' : this._waitingAtCue ? '读完继续' : this._ended ? '重新播放' : '播放';
      this.playButton.disabled = Boolean(this._error);
      this.muteButton.textContent = this.preview ? (this.media.muted ? '试听声音' : '关闭试听') : (this.media.muted ? '开声音' : '静音');
      this.muteButton.disabled = this._mutedLocked;
      this.muteButton.title = this._mutedLocked ? '实时同步时预览保持静音，声音由展示窗口播放。' : '';
      this.muteButton.setAttribute('aria-pressed', String(!this.media.muted));
      this.previousButton.disabled = !this.groupCount || this._captionIndex <= 0;
      this.nextButton.disabled = !this.groupCount || this._captionIndex >= this.groupCount - 1;
      this.status.textContent = this._error || (this._blocked ? '浏览器尚未允许播放，请点按“播放”。' : this.media.readyState === 0 ? '正在加载媒体…' : '');
      this.status.hidden = !this.status.textContent; this._refreshProgress(); this._refreshCaptionPages();
    }
    _emit(reason) { if (!this._destroyed) this.onChange({media_state: this.getState(), playing: this.playing, reason}); }
    _fail(message) {
      if (this._destroyed) return;
      this._pauseElement(); this._error = message; this._refreshUI(); this._emit('error');
    }
    destroy() {
      if (this._destroyed) return;
      this._destroyed = true; ++this._playVersion; ++this._captionRenderVersion; this._stopClock(); clearTimeout(this._followerTimer);
      clearTimeout(this._captionResizeTimer);this._captionObserver?.disconnect();this._resolveCaptionDestroyed();
      for (const [target, type, listener] of this._listeners) target.removeEventListener(type, listener);
      this._listeners = []; this.media.pause(); this.media.removeAttribute('src'); this.media.load(); this.root.remove();
    }
  }
  window.PiaMediaPlayer = PiaMediaPlayer;
})();
