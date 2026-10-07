/* AI 生成中心 —— 音视频配本页：生成弹层 + 任务队列浮层 */
(function () {
  "use strict";

  var dialog = document.getElementById("ai-video-dialog");
  var form = document.getElementById("ai-video-form");
  var platformSelect = document.getElementById("ai-video-platform");
  var modelSelect = document.getElementById("ai-video-model");
  var blockSelect = document.getElementById("ai-video-block");
  var characterSelect = document.getElementById("ai-video-character");
  var ratioSelect = document.getElementById("ai-video-ratio");
  var durationSelect = document.getElementById("ai-video-duration");
  var promptArea = document.getElementById("ai-video-prompt");
  var promptLabel = document.getElementById("ai-prompt-label");
  var errorBox = document.getElementById("ai-video-error");
  var aiHelp = document.getElementById("ai-video-help");
  var characterRow = document.getElementById("ai-character-row");
  var ratioRow = document.getElementById("ai-ratio-row");
  var durationRow = document.getElementById("ai-duration-row");
  var voiceTypeRow = document.getElementById("ai-voice-type-row");
  var voiceTypeInput = document.getElementById("ai-voice-type");
  var aiTypeTabs = document.querySelectorAll(".ai-type-tab");
  var floatBox = document.getElementById("ai-task-float");
  var floatBody = document.getElementById("ai-task-float-body");
  var floatCount = document.getElementById("ai-task-float-count");
  var floatToggle = document.getElementById("ai-task-float-toggle");
  var pickDialog = document.getElementById("ai-pick-dialog");
  var pickList = document.getElementById("ai-pick-list");
  var pickTabs = document.getElementById("ai-pick-tabs");
  var pickBlock = document.getElementById("ai-pick-block");
  var pickPreview = document.getElementById("ai-pick-preview");
  var pickInsert = document.getElementById("ai-pick-insert");
  var pickEmpty = document.getElementById("ai-pick-empty");
  var pickError = document.getElementById("ai-pick-error");
  var scriptId = document.getElementById("media-editor").dataset.scriptId;
  var scriptBlocks = [];
  var statusCache = null;
  var charactersCache = [];
  var pollTimer = null;
  var closed = false;
  var pickOutputs = [];
  var pickSelected = null;
  var aiType = "video";

  var csrf = null;
  (function readToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) { csrf = meta.content; }
  })();

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    if (csrf) { options.headers["X-CSRF-Token"] = csrf; }
    return fetch(path, options).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) {
          var error = new Error((payload && payload.error) || "请求失败");
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  function loadStatus() {
    return api("/api/ai/status").then(function (data) {
      statusCache = data;
      var config = data.config || {};
      var platforms = data.platforms || {};
      var options = Object.keys(platforms).map(function (name) {
        var info = platforms[name];
        var label = info.display || (name === "mock" ? "模拟平台（测试）" : name);
        var ready = name === "mock" || (info.api_key ? true : false);
        return { name: name, label: label + (ready ? "" : "（未配置密钥）"), ready: ready };
      });
      platformSelect.innerHTML = "";
      options.forEach(function (option) {
        var el = document.createElement("option");
        el.value = option.name;
        el.textContent = option.label;
        el.disabled = !option.ready;
        platformSelect.appendChild(el);
      });
      // 平台下只展示当前模型（模型切换收敛为默认模型）
      ratioSelect.innerHTML = "";
      Object.keys(data.ratios || {}).forEach(function (ratio) {
        var el = document.createElement("option");
        el.value = ratio;
        el.textContent = data.ratios[ratio];
        ratioSelect.appendChild(el);
      });
      durationSelect.innerHTML = "";
      (data.durations || []).forEach(function (duration) {
        var el = document.createElement("option");
        el.value = String(duration);
        el.textContent = duration + " 秒";
        durationSelect.appendChild(el);
      });
      if (config.default_ratio) { ratioSelect.value = config.default_ratio; }
      if (config.default_duration) { durationSelect.value = String(config.default_duration); }
      var selectedPlatform = config.platforms && Object.keys(config.platforms).find(function (name) {
        return config.platforms[name].api_key;
      });
      if (selectedPlatform) { platformSelect.value = selectedPlatform; }
      else if (platformSelect.querySelector('option:not([disabled])')) { platformSelect.value = "mock"; }
      fillModels(platformSelect.value);
    });
  }

  // 按所选平台填充「可用模型」下拉（字节走 AK/SK 已开通过滤，只显示真实可用的模型）
  function fillModels(platform) {
    var info = (statusCache && statusCache.platforms && statusCache.platforms[platform]) || {};
    var bucket = { image: "image_models", audio: "audio_models", voice: "voice_models" }[aiType] || "models";
    var models = info[bucket] || {};
    var blocked = info.unavailable_models || [];
    var keys = Object.keys(models).filter(function (k) { return blocked.indexOf(k) < 0; });
    modelSelect.innerHTML = "";
    if (!keys.length) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "暂无可用模型（请到「AI 生成设置」刷新或开通后重试）";
      modelSelect.appendChild(empty);
      return;
    }
    keys.forEach(function (k) {
      var el = document.createElement("option");
      el.value = k;
      el.textContent = models[k] || k;
      modelSelect.appendChild(el);
    });
  }

  // 生成类型切换：视频 / 图片 / 音乐 / 配音（字段显隐、模型桶、提示文案）
  var aiTypeDefs = {
    video: { help: "把一段剧情文字交给生成服务，产出视频后自动插入到该正文段落后方。", prompt: "剧情描述", placeholder: "描述画面内容与氛围；留空时使用所选段落的原文", character: true, ratio: true, duration: true, voice: false },
    image: { help: "生成一张剧情配图，产出后自动插入到该正文段落后方（也可生成角色形象卡）。", prompt: "图片描述", placeholder: "描述画面内容与风格；留空时使用所选段落的原文", character: true, ratio: true, duration: false, voice: false },
    audio: { help: "生成一段背景音乐/音效（如“雨夜忧伤的钢琴背景音乐”），产出后自动插入到该正文段落后方。", prompt: "音乐描述", placeholder: "描述音乐风格、场景与情绪，例如：雨夜忧伤的钢琴背景音乐，节奏舒缓", character: false, ratio: false, duration: false, voice: false },
    voice: { help: "把一段文本转成语音配音（旁白/台词），产出后自动插入到该正文段落后方。", prompt: "配音文本", placeholder: "输入要朗读的旁白或台词文本（留空时使用所选段落的原文）", character: false, ratio: false, duration: false, voice: true },
  };

  function switchType(type) {
    aiType = type;
    var def = aiTypeDefs[type] || aiTypeDefs.video;
    aiTypeTabs.forEach(function (tab) {
      tab.classList.toggle("is-active", tab.dataset.aiType === type);
    });
    aiHelp.textContent = def.help;
    promptLabel.textContent = def.prompt;
    promptArea.placeholder = def.placeholder;
    characterRow.hidden = !def.character;
    ratioRow.hidden = !def.ratio;
    durationRow.hidden = !def.duration;
    voiceTypeRow.hidden = !def.voice;
    fillModels(platformSelect.value);
  }

  aiTypeTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      errorBox.hidden = true;
      switchType(tab.dataset.aiType);
    });
  });

  function fillVideoModels(platform) {
    var info = (statusCache && statusCache.platforms && statusCache.platforms[platform]) || {};
    var models = info.models || {};
    var blocked = info.unavailable_models || [];
    var keys = Object.keys(models).filter(function (k) { return blocked.indexOf(k) < 0; });
    modelSelect.innerHTML = "";
    if (!keys.length) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "暂无可用模型（请到「AI 生成设置」刷新或开通后重试）";
      modelSelect.appendChild(empty);
      return;
    }
    keys.forEach(function (k) {
      var el = document.createElement("option");
      el.value = k;
      el.textContent = models[k] || k;
      modelSelect.appendChild(el);
    });
  }

  function loadCharacters() {
    return api("/api/ai/characters").then(function (data) {
      charactersCache = data.characters || [];
      characterSelect.innerHTML = '<option value="">不指定</option>';
      charactersCache.forEach(function (character) {
        var el = document.createElement("option");
        el.value = character.id;
        var applied = (character.uses || []).filter(function (use) { return use.script_id === scriptId; });
        var extra = "";
        if (applied.length) {
          extra = "（本剧本已应用： " + applied.map(function (use) { return use.alias || use.script_title; }).join("、") + "）";
        } else if (character.image_file) {
          extra = "（有形象图）";
        }
        el.textContent = character.name + extra;
        characterSelect.appendChild(el);
      });
    });
  }

  function fillBlockOptions(select) {
    select.innerHTML = "";
    scriptBlocks.filter(function (block) { return block.kind === "text" && block.text; }).forEach(function (block) {
      var el = document.createElement("option");
      el.value = block.id;
      var text = (block.role ? block.role + "：" : "") + String(block.text || "").replace(/\s+/g, " ").slice(0, 40);
      el.textContent = text;
      select.appendChild(el);
    });
    if (!select.options.length) {
      scriptBlocks.forEach(function (block) {
        var el = document.createElement("option");
        el.value = block.id;
        el.textContent = "（非文字段落）" + block.id;
        select.appendChild(el);
      });
    }
  }

  function loadBlocks() {
    return api("/api/library").then(function (data) {
      var script = (data.scripts || []).find(function (item) { return item.id === scriptId; });
      scriptBlocks = script ? (script.blocks || []) : [];
      fillBlockOptions(blockSelect);
      fillBlockOptions(pickBlock);
    });
  }

  function openDialog() {
    errorBox.hidden = true;
    errorBox.textContent = "";
    promptArea.value = "";
    Promise.all([loadStatus(), loadCharacters(), loadBlocks()]).then(function () {
      dialog.showModal();
    }).catch(function (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      dialog.showModal();
    });
  }

  function closeDialog() {
    if (dialog.open) { dialog.close(); }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!blockSelect.value) { errorBox.textContent = "请选择目标段落。"; errorBox.hidden = false; return; }
    if (!modelSelect.value) { errorBox.textContent = "当前平台暂无可用模型，请到「AI 生成设置」刷新模型或开通后重试。"; errorBox.hidden = false; return; }
    var character = charactersCache.find(function (item) { return item.id === characterSelect.value; });
    var prompt = promptArea.value.trim();
    if (!prompt) {
      var block = scriptBlocks.find(function (item) { return item.id === blockSelect.value; });
      prompt = (block && block.text) ? block.text.replace(/\s+/g, " ").slice(0, 1500) : "";
    }
    if (!prompt) { errorBox.textContent = "请输入生成描述或配音文本（所选段落无可用原文）。"; errorBox.hidden = false; return; }
    var endpoint, payload;
    if (aiType === "video") {
      endpoint = "/api/ai/video/generate";
      payload = {
        prompt: prompt,
        platform: platformSelect.value,
        model: modelSelect.value,
        ratio: ratioSelect.value,
        duration: parseInt(durationSelect.value, 10) || 10,
        script_id: scriptId,
        block_id: blockSelect.value,
        role_name: character ? character.name : "",
        ref_image: character && character.image_file ? character.image_file : null,
      };
    } else if (aiType === "image") {
      endpoint = "/api/ai/image/generate";
      payload = {
        prompt: prompt,
        platform: platformSelect.value,
        model: modelSelect.value,
        ratio: ratioSelect.value,
        script_id: scriptId,
        block_id: blockSelect.value,
        role_name: character ? character.name : "",
      };
    } else if (aiType === "audio") {
      endpoint = "/api/ai/audio/generate";
      payload = {
        prompt: prompt,
        platform: platformSelect.value,
        model: modelSelect.value,
        script_id: scriptId,
        block_id: blockSelect.value,
      };
    } else {
      endpoint = "/api/ai/voice/generate";
      payload = {
        text: prompt,
        platform: platformSelect.value,
        model: modelSelect.value,
        voice_type: voiceTypeInput.value.trim(),
        script_id: scriptId,
        block_id: blockSelect.value,
      };
    }
    var submit = document.getElementById("ai-video-form").querySelector("button[type=submit]");
    submit.disabled = true;
    api(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function () {
        closed = false;
        closeDialog();
        showFloat();
        refreshTasks();
      })
      .catch(function (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      })
      .finally(function () {
        submit.disabled = false;
      });
  });

  function showFloat() {
    floatBox.hidden = false;
    floatBox.classList.remove("collapsed");
    pollTimer = pollTimer || setInterval(refreshTasks, 1500);
  }

  function refreshTasks() {
    api("/api/ai/tasks?limit=50").then(function (data) {
      var tasks = data.tasks || [];
      var active = tasks.filter(function (task) { return task.status === "queued" || task.status === "running"; });
      floatCount.textContent = String(tasks.length);
      if (!tasks.length) {
        floatBody.innerHTML = '<div class="ai-task-empty">暂无生成任务。</div>';
        return;
      }
      floatBody.innerHTML = "";
      tasks.slice(0, 20).forEach(function (task) {
        var item = document.createElement("div");
        item.className = "ai-task-item";
        var kind = { video: "视频", image: "图片", audio: "音乐", voice: "配音" }[task.kind] || task.kind;
        var platformLabel = task.platform === "mock" ? "模拟" : (task.platform === "byte" ? "字节" : "阿里");
        var statusLabel = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[task.status] || task.status;
        if (task.status === "succeeded" && task.kind === "video" && task.script_id === scriptId) {
          statusLabel = "已完成 · 已插入正文";
        }
        var title = task.prompt ? task.prompt.replace(/\s+/g, " ").slice(0, 30) : (kind + " " + task.task_id);
        item.innerHTML =
          '<div class="ai-task-item-top"><span class="ai-task-item-kind">' + kind + "</span>" +
          '<span class="ai-task-item-title">' + escapeHtml(title) + "</span>" +
          '<span class="ai-task-item-status ' + task.status + '">' + statusLabel + (task.platform ? " · " + platformLabel : "") + "</span></div>" +
          '<div class="ai-task-bar"><span style="width:' + Math.max(4, task.progress || 0) + '%"></span></div>';
        if (task.error && task.status === "failed") {
          var error = document.createElement("div");
          error.className = "ai-task-item-error";
          error.textContent = task.error;
          item.appendChild(error);
        }
        if (task.status === "queued" || task.status === "running") {
          var actions = document.createElement("div");
          actions.className = "ai-task-item-actions";
          var cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "button secondary small";
          cancel.textContent = "取消";
          cancel.addEventListener("click", function () { api("/api/ai/tasks/" + task.task_id + "/cancel", { method: "POST" }); });
          actions.appendChild(cancel);
          item.appendChild(actions);
        } else if (task.status === "failed" || task.status === "cancelled") {
          var retry = document.createElement("button");
          retry.type = "button";
          retry.className = "task-retry-button";
          retry.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>重试';
          retry.addEventListener("click", function () {
            api("/api/ai/tasks/" + task.task_id + "/retry", { method: "POST" }).then(refreshTasks);
          });
          var actions2 = document.createElement("div");
          actions2.className = "ai-task-item-actions";
          actions2.appendChild(retry);
          item.appendChild(actions2);
        }
        floatBody.appendChild(item);
      });
      var videoDone = tasks.find(function (task) { return task.kind === "video" && task.status === "succeeded" && task.script_id === scriptId; });
      if (videoDone && !closed) {
        // 视频已自动插入正文段落：通知配本页刷新段落列表（保留队列中的完成反馈，不整页刷新）
        closed = true;
        clearInterval(pollTimer);
        pollTimer = null;
        window.dispatchEvent(new CustomEvent("ai-media-inserted"));
      }
    }).catch(function () { /* 网络抖动忽略，下轮重试 */ });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) { return ""; }
    if (bytes < 1024) { return bytes + " B"; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + " KB"; }
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  var pickTab = "all";
  var pickTabDefs = [
    { key: "all", label: "全部" },
    { key: "video", label: "视频" },
    { key: "audio", label: "音乐" },
    { key: "voice", label: "配音" },
    { key: "image", label: "图片" },
  ];

  function renderPickTabs() {
    pickTabs.innerHTML = "";
    pickTabDefs.forEach(function (def) {
      var count = def.key === "all" ? pickOutputs.length
        : pickOutputs.filter(function (item) { return item.kind === def.key; }).length;
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "ai-pick-tab" + (pickTab === def.key ? " is-active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", pickTab === def.key ? "true" : "false");
      tab.innerHTML = escapeHtml(def.label) +
        (def.key === "audio" ? '<span class="ai-pick-tab-hint">预留</span>' : "") +
        '<span class="ai-pick-tab-count">' + count + "</span>";
      tab.addEventListener("click", function () {
        pickTab = def.key;
        pickSelected = null;
        pickPreview.innerHTML = '<p class="muted">选择左侧产物后预览。</p>';
        renderPickList();
        renderPickTabs();
        pickInsert.disabled = true;
      });
      pickTabs.appendChild(tab);
    });
  }

  function renderPickList() {
    pickList.innerHTML = "";
    var filtered = pickTab === "all"
      ? pickOutputs
      : pickOutputs.filter(function (item) { return item.kind === pickTab; });
    pickEmpty.hidden = filtered.length > 0;
    pickEmpty.textContent = filtered.length ? "" : "该分类下暂无产物。";
    filtered.forEach(function (item) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "ai-pick-item" + (item.kind === "image" ? " is-image" : "");
      el.setAttribute("role", "option");
      var label = { video: "视频", audio: "音乐", voice: "配音", image: "图片" }[item.kind] || item.kind;
      var meta = formatSize(item.size) + " · " + new Date(item.created_at).toLocaleString();
      var prompt = "";
      if (item.meta && item.meta.prompt) {
        prompt = '<span class="ai-pick-prompt">' + escapeHtml(String(item.meta.prompt).replace(/\s+/g, " ").slice(0, 60)) + "</span>";
      } else {
        prompt = '<span class="ai-pick-prompt is-empty">（历史产物，无提示词记录）</span>';
      }
      el.innerHTML = '<span class="ai-pick-kind">' + label + "</span>" +
        '<span class="ai-pick-name">' + escapeHtml(item.filename) + "</span>" +
        '<span class="ai-pick-meta">' + meta + "</span>" + prompt;
      el.addEventListener("click", function () { selectOutput(item, el); });
      pickList.appendChild(el);
    });
  }

  function loadOutputs() {
    return api("/api/ai/outputs").then(function (data) {
      pickOutputs = data.outputs || [];
      renderPickTabs();
      renderPickList();
    });
  }

  function selectOutput(item, el) {
    pickList.querySelectorAll(".is-selected").forEach(function (node) { node.classList.remove("is-selected"); });
    el.classList.add("is-selected");
    pickSelected = item;
    pickPreview.innerHTML = "";
    if (item.kind === "video") {
      var v = document.createElement("video");
      v.src = item.url; v.controls = true; v.preload = "metadata"; v.playsInline = true;
      v.style.width = "100%"; v.style.maxHeight = "240px"; v.style.background = "#111";
      pickPreview.appendChild(v);
      var nameV = document.createElement("p");
      nameV.className = "muted"; nameV.textContent = item.filename;
      pickPreview.appendChild(nameV);
    } else if (item.kind === "audio" || item.kind === "voice") {
      var a = document.createElement("audio");
      a.src = item.url; a.controls = true; a.preload = "metadata";
      a.style.width = "100%";
      pickPreview.appendChild(a);
      var nameA = document.createElement("p");
      nameA.className = "muted"; nameA.textContent = item.filename;
      pickPreview.appendChild(nameA);
    } else {
      var img = document.createElement("img");
      img.src = item.url; img.alt = item.filename;
      img.style.maxWidth = "100%"; img.style.maxHeight = "220px";
      pickPreview.appendChild(img);
      var note = document.createElement("p");
      note.className = "muted"; note.textContent = "图片产物仅可预览，暂不支持插入正文。";
      pickPreview.appendChild(note);
    }
    pickInsert.disabled = item.kind === "image";
    pickError.hidden = true;
    pickError.textContent = "";
  }

  function openPick() {
    pickError.hidden = true; pickError.textContent = "";
    pickSelected = null; pickInsert.disabled = true;
    pickPreview.innerHTML = '<p class="muted">选择左侧产物后预览。</p>';
    Promise.all([loadBlocks(), loadOutputs()]).then(function () {
      pickDialog.showModal();
    }).catch(function (error) {
      pickError.textContent = error.message; pickError.hidden = false;
      pickDialog.showModal();
    });
  }

  function closePick() {
    if (pickDialog.open) { pickDialog.close(); }
    pickSelected = null; pickInsert.disabled = true;
  }

  document.getElementById("media-ai-generate").addEventListener("click", openDialog);
  document.querySelectorAll("[data-ai-close]").forEach(function (button) {
    button.addEventListener("click", closeDialog);
  });
  document.getElementById("media-ai-pick").addEventListener("click", openPick);
  document.querySelectorAll("[data-ai-pick-close]").forEach(function (button) {
    button.addEventListener("click", closePick);
  });
  if (pickInsert) {
    pickInsert.addEventListener("click", function () {
      if (!pickSelected || pickSelected.kind === "image") { return; }
      if (!pickBlock.value) { pickError.textContent = "请选择目标段落。"; pickError.hidden = false; return; }
      pickInsert.disabled = true;
      api("/api/ai/outputs/" + encodeURIComponent(pickSelected.filename) + "/insert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script_id: scriptId, block_id: pickBlock.value }),
      }).then(function () {
        closePick();
        window.dispatchEvent(new CustomEvent("ai-media-inserted"));
        piaAlert("已插入正文段落后方。");
      }).catch(function (error) {
        pickError.textContent = error.message; pickError.hidden = false;
        pickInsert.disabled = false;
      });
    });
  }
  // 切换平台时联动刷新「可用模型」下拉
  if (platformSelect) {
    platformSelect.addEventListener("change", function () { fillModels(platformSelect.value); });
  }
  if (floatToggle) {
    floatToggle.addEventListener("click", function () {
      floatBox.classList.toggle("collapsed");
      floatToggle.textContent = floatBox.classList.contains("collapsed") ? "▸" : "▾";
    });
  }
  var floatClear = document.getElementById("ai-task-float-clear");
  if (floatClear) {
    floatClear.addEventListener("click", function () {
      if (floatBox.classList.contains("collapsed")) { return; }
      var done = document.querySelectorAll(".ai-task-item .ai-task-item-status.succeeded, .ai-task-item .ai-task-item-status.failed, .ai-task-item .ai-task-item-status.cancelled").length;
      if (!done) { return; }
      piaConfirm("清除全部「已完成 / 失败 / 已取消」的任务记录？\n排队中和生成中的任务会保留。").then(function (ok) {
        if (!ok) { return; }
        api("/api/ai/tasks/finished", { method: "DELETE" }).then(function () {
          refreshTasks();
        }).catch(function () { piaAlert("清除失败，请重试。"); });
      });
    });
  }
  // 页面加载即展示既有任务队列（含上次未完成的）
  refreshTasks();
  api("/api/ai/status").then(function (data) {
    if ((data.tasks && data.tasks.length) || true) {
      var active = document.querySelectorAll(".ai-task-item").length;
    }
  }).catch(function () {});
})();
