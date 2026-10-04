/* AI 生成中心 —— 音视频配本页：生成弹层 + 任务队列浮层 */
(function () {
  "use strict";

  var dialog = document.getElementById("ai-video-dialog");
  var form = document.getElementById("ai-video-form");
  var platformSelect = document.getElementById("ai-video-platform");
  var blockSelect = document.getElementById("ai-video-block");
  var characterSelect = document.getElementById("ai-video-character");
  var ratioSelect = document.getElementById("ai-video-ratio");
  var durationSelect = document.getElementById("ai-video-duration");
  var promptArea = document.getElementById("ai-video-prompt");
  var errorBox = document.getElementById("ai-video-error");
  var floatBox = document.getElementById("ai-task-float");
  var floatBody = document.getElementById("ai-task-float-body");
  var floatCount = document.getElementById("ai-task-float-count");
  var floatToggle = document.getElementById("ai-task-float-toggle");
  var scriptId = document.getElementById("media-editor").dataset.scriptId;
  var scriptBlocks = [];
  var statusCache = null;
  var charactersCache = [];
  var pollTimer = null;
  var closed = false;

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
      var platforms = config.platforms || {};
      var options = Object.keys(platforms).map(function (name) {
        var info = platforms[name];
        var label = name === "mock" ? "模拟平台（测试）" : (name === "byte" ? "字节 · 豆包 seedance" : "阿里 · 通义万相");
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
      var models = { mock: { "mock-v1": "模拟模型 v1" }, byte: { "seedance-1.0-pro": "Seedance 1.0 Pro" }, ali: { "wanx2.1-t2v-turbo": "万相 2.1 文生视频" } };
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

  function loadBlocks() {
    return api("/api/library").then(function (data) {
      var script = (data.scripts || []).find(function (item) { return item.id === scriptId; });
      scriptBlocks = script ? (script.blocks || []) : [];
      blockSelect.innerHTML = "";
      scriptBlocks.filter(function (block) { return block.kind === "text" && block.text; }).forEach(function (block) {
        var el = document.createElement("option");
        el.value = block.id;
        var text = (block.role ? block.role + "：" : "") + String(block.text || "").replace(/\s+/g, " ").slice(0, 40);
        el.textContent = text;
        blockSelect.appendChild(el);
      });
      if (!blockSelect.options.length) {
        scriptBlocks.forEach(function (block) {
          var el = document.createElement("option");
          el.value = block.id;
          el.textContent = "（非文字段落）" + block.id;
          blockSelect.appendChild(el);
        });
      }
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
    var character = charactersCache.find(function (item) { return item.id === characterSelect.value; });
    var prompt = promptArea.value.trim();
    if (!prompt) {
      var block = scriptBlocks.find(function (item) { return item.id === blockSelect.value; });
      prompt = (block && block.text) ? block.text.replace(/\s+/g, " ").slice(0, 1500) : "";
    }
    var payload = {
      prompt: prompt,
      platform: platformSelect.value,
      model: "",
      ratio: ratioSelect.value,
      duration: parseInt(durationSelect.value, 10) || 10,
      script_id: scriptId,
      block_id: blockSelect.value,
      role_name: character ? character.name : "",
      ref_image: character && character.image_file ? character.image_file : null,
    };
    var submit = document.getElementById("ai-video-form").querySelector("button[type=submit]");
    submit.disabled = true;
    api("/api/ai/video/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function () {
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
        var kind = task.kind === "image" ? "形象图" : "视频";
        var platformLabel = task.platform === "mock" ? "模拟" : (task.platform === "byte" ? "字节" : "阿里");
        var statusLabel = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[task.status] || task.status;
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
          retry.className = "button secondary small";
          retry.textContent = "重试";
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
        // 视频已自动挂载：刷新页面让播放器加载新媒体
        closed = true;
        clearInterval(pollTimer);
        pollTimer = null;
        setTimeout(function () { location.reload(); }, 1200);
      }
    }).catch(function () { /* 网络抖动忽略，下轮重试 */ });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  document.getElementById("media-ai-generate").addEventListener("click", openDialog);
  document.querySelectorAll("[data-ai-close]").forEach(function (button) {
    button.addEventListener("click", closeDialog);
  });
  if (floatToggle) {
    floatToggle.addEventListener("click", function () {
      floatBox.classList.toggle("collapsed");
      floatToggle.textContent = floatBox.classList.contains("collapsed") ? "+" : "–";
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
