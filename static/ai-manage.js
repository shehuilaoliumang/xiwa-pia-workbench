/* AI 生成中心 —— 内容管理页：设置 + 全局角色形象库 */
(function () {
  "use strict";

  var settingsDialog = document.getElementById("ai-settings-dialog");
  var charactersDialog = document.getElementById("ai-characters-dialog");
  var csrf = null;
  var meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) { csrf = meta.content; }
  var charactersCache = [];
  var currentId = null;

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    if (csrf) { options.headers["X-CSRF-Token"] = csrf; }
    return fetch(path, options).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) {
          var error = new Error((payload && payload.error) || "请求失败");
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  // 把平台原始报错转成带操作指引的提示
  function friendlyError(message, platform) {
    var text = String(message || "生成失败");
    if (platform === "byte") {
      if (/ModelNotOpen|not activated|InvalidEndpointOrModel|does not exist/.test(text)) {
        return "字节模型未开通：" + text.slice(0, 160) + "。请到火山方舟控制台（console.volcengine.com/ark）→「开通管理」开通对应模型后重试。";
      }
    } else if (platform === "ali") {
      if (/not support|invalid|403|forbidden|no permission/i.test(text)) {
        return "阿里接口返回：" + text.slice(0, 160) + "。请确认百炼控制台已开通对应模型服务。";
      }
    }
    return text;
  }

  // ---------- 设置 ----------

  function fillRatioOptions(selected) {
    var ratios = { "9:16": "竖屏 9:16", "16:9": "横屏 16:9", "1:1": "方形 1:1", "3:4": "竖屏 3:4", "4:3": "横屏 4:3" };
    var select = document.getElementById("ai-default-ratio");
    select.innerHTML = "";
    Object.keys(ratios).forEach(function (key) {
      var el = document.createElement("option");
      el.value = key;
      el.textContent = ratios[key];
      if (key === selected) { el.selected = true; }
      select.appendChild(el);
    });
  }

  var platformCatalog = {};

  function fillModelOptions(selectId, models, selected, unavailable, authoritative) {
    var select = document.getElementById(selectId);
    if (!select) { return; }
    select.innerHTML = "";
    // 实测确认未开通的模型不显示（避免反复 404）；只展示可用或尚未验证的模型
    var blocked = unavailable || [];
    var keys = Object.keys(models || {}).filter(function (key) { return blocked.indexOf(key) < 0; });
    keys.forEach(function (key) {
      var el = document.createElement("option");
      el.value = key;
      el.textContent = models[key];
      el.selected = key === selected;
      select.appendChild(el);
    });
    // 列表为空：必须给出占位选项（否则下拉空白，看起来"无反应"）
    if (!keys.length) {
      var empty = document.createElement("option");
      empty.value = selected || "";
      empty.textContent = authoritative
        ? "暂无已开通的" + (selectId.indexOf("image") >= 0 ? "图像" : "视频") + "模型（请到火山方舟开通后点「刷新模型」）"
        : (selected ? selected + "（自定义）" : "暂无可用模型");
      empty.selected = true;
      select.appendChild(empty);
    } else if (selected && !(selected in models)) {
      // 保存的模型不在当前可用列表：默认选第一个可用模型（避免生成失败）
      select.selectedIndex = 0;
    }
  }

  function testPlatform(platform, buttonId, statusId) {
    var button = document.getElementById(buttonId);
    var status = document.getElementById(statusId);
    if (!button || !status) { return; }
    button.disabled = true;
    status.textContent = "正在测试连接…";
    api("/api/ai/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: platform }) })
      .then(function (result) {
        status.textContent = result.ok ? "✓ " + result.message : "✗ " + result.message;
        status.hidden = false;
      })
      .catch(function (error) {
        status.textContent = "测试失败：" + error.message;
        status.hidden = false;
      })
      .finally(function () { button.disabled = false; });
  }

  function refreshPlatformModels(platform, selectId, statusId, buttonId) {
    var button = document.getElementById(buttonId);
    var status = document.getElementById(statusId);
    if (button) { button.disabled = true; }
    if (status) { status.textContent = "正在查询账号可用模型…"; status.hidden = false; }
    var previousValue = (document.getElementById(selectId) || {}).value;
    api("/api/ai/models/refresh", { method: "POST" })
      .then(function (result) {
        platformCatalog = result.platforms || platformCatalog;
        var models = (platformCatalog[platform] || {}).models || {};
        var info = (platformCatalog[platform] || {});
        var filtered = !!(info.has_ak && info.has_sk);
        fillModelOptions(selectId, models, previousValue, (platformCatalog[platform] || {}).unavailable_models, filtered);
        var count = Object.keys(models).length;
        if (status) { status.textContent = count ? "✓ 已刷新：显示 " + count + " 个可用模型（来自你的 Key）" : "✓ 已刷新：该 Key 暂未查询到视频模型，使用内置默认列表"; }
      })
      .catch(function (error) {
        if (status) { status.textContent = "刷新失败：" + error.message + "（继续使用内置默认模型列表）"; }
      })
      .finally(function () { if (button) { button.disabled = false; } });
  }

  document.getElementById("ai-byte-refresh").addEventListener("click", function () {
    refreshPlatformModels("byte", "ai-byte-model", "ai-byte-test-status", "ai-byte-refresh");
  });
  document.getElementById("ai-ali-refresh").addEventListener("click", function () {
    refreshPlatformModels("ali", "ai-ali-model", "ai-ali-test-status", "ai-ali-refresh");
  });
  document.getElementById("ai-ali-activations").addEventListener("click", function () {
    var button = document.getElementById("ai-ali-activations");
    var status = document.getElementById("ai-ali-test-status");
    if (!button || !status) { return; }
    button.disabled = true;
    status.textContent = "正在查询阿里百炼开通状态…";
    api("/api/ai/ali/activations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (result) {
        if (!result.ok) { status.textContent = "✗ " + (result.error || result.message || "查询失败"); return; }
        var lines = [];
        lines.push("✓ " + (result.message || "开通状态检查完成"));
        lines.push("图片生成（已开通 " + result.image_count + " 个）：" + ((result.image_models || []).slice(0, 6).join("、") || "—") + ((result.image_count || 0) > 6 ? " 等" : ""));
        lines.push("配音（已开通 " + result.voice_count + " 个）：" + ((result.voice_models || []).slice(0, 5).join("、") || "—") + ((result.voice_count || 0) > 5 ? " 等" : ""));
        lines.push("视频：" + (result.video_note || "无法静态确认，请以实际生成为准。"));
        lines.push("音乐：" + (result.music_note || "需业务空间 ID，实际生成验证。"));
        status.textContent = lines.join("\n");
        status.hidden = false;
      })
      .catch(function (error) {
        status.textContent = "开通状态查询失败：" + error.message;
        status.hidden = false;
      })
      .finally(function () { button.disabled = false; });
  });

  function fillDurationOptions(selected) {
    var select = document.getElementById("ai-default-duration");
    select.innerHTML = "";
    [5, 10, 15, 20, 30].forEach(function (duration) {
      var el = document.createElement("option");
      el.value = String(duration);
      el.textContent = duration + " 秒";
      if (duration === selected) { el.selected = true; }
      select.appendChild(el);
    });
  }

  function openSettings() {
    api("/api/ai/status").then(function (data) {
      var config = data.config || {};
      platformCatalog = data.platforms || {};
      document.getElementById("ai-enabled").checked = !!config.enabled;
      fillRatioOptions(config.default_ratio || "9:16");
      fillDurationOptions(config.default_duration || 10);
      var byte = (config.platforms && config.platforms.byte) || {};
      var ali = (config.platforms && config.platforms.ali) || {};
      var platformInfo = (data.platforms && data.platforms.byte) || {};
      var byteFiltered = !!(platformInfo.has_ak && platformInfo.has_sk);
      fillModelOptions("ai-byte-model", (platformCatalog.byte || {}).models, byte.model || "seedance-2.0-pro", (platformCatalog.byte || {}).unavailable_models, byteFiltered);
      fillModelOptions("ai-byte-voice-model", (platformCatalog.byte || {}).voice_models, byte.voice_model || "seed-audio-1.0", (platformCatalog.byte || {}).unavailable_models, false);
      fillModelOptions("ai-ali-model", (platformCatalog.ali || {}).models, ali.model || "wanx2.1-t2v-turbo", (platformCatalog.ali || {}).unavailable_models);
      fillModelOptions("ai-ali-audio-model", (platformCatalog.ali || {}).audio_models, ali.audio_model || "fun-music-v1", (platformCatalog.ali || {}).unavailable_models);
      fillModelOptions("ai-ali-voice-model", (platformCatalog.ali || {}).voice_models, ali.voice_model || "qwen-audio-3.1-tts-next", (platformCatalog.ali || {}).unavailable_models);
      document.getElementById("ai-byte-key").value = byte.api_key || "";
      document.getElementById("ai-byte-ak").value = byte.ak || "";
      document.getElementById("ai-byte-tts-key").value = byte.tts_api_key || "";
      document.getElementById("ai-ali-workspace").value = ali.workspace_id || "";
      // SecretKey 不回显（安全）；占位提示反映实际配置状态；留空保存即保持不变
      var skEl = document.getElementById("ai-byte-sk");
      skEl.value = "";
      skEl.placeholder = platformInfo.has_sk ? "已配置（留空保持不变）" : "未配置";
      var akEl = document.getElementById("ai-byte-ak");
      akEl.placeholder = platformInfo.has_ak ? "已配置（留空保持不变）" : "AKLT… 访问密钥 ID";
      var ttsEl = document.getElementById("ai-byte-tts-key");
      ttsEl.placeholder = platformInfo.has_tts_api_key ? "已配置（留空保持不变）" : "配音走豆包语音独立服务，与方舟 Key 不同";
      document.getElementById("ai-ali-key").value = ali.api_key || "";
      document.getElementById("ai-byte-test-status").hidden = true;
      document.getElementById("ai-ali-test-status").hidden = true;
      document.getElementById("ai-settings-error").hidden = true;
      settingsDialog.showModal();
    }).catch(function (error) {
      document.getElementById("ai-settings-error").textContent = error.message;
      document.getElementById("ai-settings-error").hidden = false;
    });
  }

  document.getElementById("ai-byte-test").addEventListener("click", function () {
    testPlatform("byte", "ai-byte-test", "ai-byte-test-status");
  });
  document.getElementById("ai-ali-test").addEventListener("click", function () {
    testPlatform("ali", "ai-ali-test", "ai-ali-test-status");
  });

  // 重置“实测未开通”记录：开通模型后恢复全部模型显示
  document.getElementById("ai-unavailable-reset").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platforms: { byte: { unavailable_models: [] }, ali: { unavailable_models: [] } } }),
    }).then(function () {
      button.disabled = false;
      document.getElementById("ai-settings-error").hidden = true;
      return api("/api/ai/status");
    }).then(function (data) {
      platformCatalog = data.platforms || {};
      var byte = (data.config && data.config.platforms && data.config.platforms.byte) || {};
      var ali = (data.config && data.config.platforms && data.config.platforms.ali) || {};
      var byteInfo = (data.platforms && data.platforms.byte) || {};
      var byteFiltered = !!(byteInfo.has_ak && byteInfo.has_sk);
      fillModelOptions("ai-byte-model", (platformCatalog.byte || {}).models, byte.model || "", (platformCatalog.byte || {}).unavailable_models, byteFiltered);
      fillModelOptions("ai-byte-voice-model", (platformCatalog.byte || {}).voice_models, byte.voice_model || "", (platformCatalog.byte || {}).unavailable_models, false);
      fillModelOptions("ai-ali-model", (platformCatalog.ali || {}).models, ali.model || "", (platformCatalog.ali || {}).unavailable_models);
      fillModelOptions("ai-ali-audio-model", (platformCatalog.ali || {}).audio_models, ali.audio_model || "", (platformCatalog.ali || {}).unavailable_models);
      fillModelOptions("ai-ali-voice-model", (platformCatalog.ali || {}).voice_models, ali.voice_model || "", (platformCatalog.ali || {}).unavailable_models);
      document.getElementById("ai-settings-error").textContent = "已重置未开通记录，模型列表已恢复全部显示。";
      document.getElementById("ai-settings-error").hidden = false;
    }).catch(function (error) {
      button.disabled = false;
      document.getElementById("ai-settings-error").textContent = "重置失败：" + error.message;
      document.getElementById("ai-settings-error").hidden = false;
    });
  });

  // 一键测试字节「开通状态」：AK/SK 签名查询已开通模型（不产生费用；留空回退已保存凭证）
  document.getElementById("ai-byte-act-test").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    var status = document.getElementById("ai-byte-test-status");
    status.hidden = false;
    status.textContent = "正在查询已开通模型…";
    api("/api/ai/byte/activations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ak: document.getElementById("ai-byte-ak").value.trim(),
        sk: document.getElementById("ai-byte-sk").value.trim(),
      }),
    }).then(function (result) {
      if (result && result.ok) {
        var tail = "";
        if (result.activated && result.activated.length) {
          tail = "：" + result.activated.slice(0, 12).join("、") + (result.activated.length > 12 ? " 等" : "");
        }
        status.textContent = (result.message || "").replace(/。$/, "") + tail;
      } else {
        status.textContent = (result && result.error) || "查询失败。";
      }
    }).catch(function (error) {
      status.textContent = "查询失败：" + error.message;
    }).finally(function () { button.disabled = false; });
  });

  document.getElementById("ai-settings-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var payload = {
      enabled: document.getElementById("ai-enabled").checked,
      default_ratio: document.getElementById("ai-default-ratio").value,
      default_duration: parseInt(document.getElementById("ai-default-duration").value, 10),
      platforms: {
        byte: {
          model: document.getElementById("ai-byte-model").value,
          voice_model: document.getElementById("ai-byte-voice-model").value,
          // API Key / AccessKey 留空 = 保持已保存值不变（防止误清空；与 SecretKey 同策略）
          api_key: (function () { var v = document.getElementById("ai-byte-key").value.trim(); return v ? v : undefined; })(),
          ak: (function () { var v = document.getElementById("ai-byte-ak").value.trim(); return v ? v : undefined; })(),
          // SecretKey 输入框留空时保持已保存值不变（不回显）
          sk: (function () { var v = document.getElementById("ai-byte-sk").value.trim(); return v ? v : undefined; })(),
          tts_api_key: (function () { var v = document.getElementById("ai-byte-tts-key").value.trim(); return v ? v : undefined; })(),
        },
        ali: {
          model: document.getElementById("ai-ali-model").value,
          audio_model: document.getElementById("ai-ali-audio-model").value,
          voice_model: document.getElementById("ai-ali-voice-model").value,
          api_key: document.getElementById("ai-ali-key").value.trim(),
          workspace_id: document.getElementById("ai-ali-workspace").value.trim(),
        },
      },
    };
    api("/api/ai/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (result) {
        settingsDialog.close();
        // 保存密钥后自动刷新可用模型列表（下次打开设置即显示）
        var config = (result && result.config) || {};
        api("/api/ai/models/refresh", { method: "POST" })
          .then(function (refreshed) {
            platformCatalog = refreshed.platforms || platformCatalog;
            var byte = (config.platforms && config.platforms.byte) || {};
            var ali = (config.platforms && config.platforms.ali) || {};
            var byteInfo = (refreshed.platforms && refreshed.platforms.byte) || {};
            var byteFiltered = !!(byteInfo.has_ak && byteInfo.has_sk);
            fillModelOptions("ai-byte-model", (platformCatalog.byte || {}).models, byte.model, (platformCatalog.byte || {}).unavailable_models, byteFiltered);
            fillModelOptions("ai-byte-voice-model", (platformCatalog.byte || {}).voice_models, byte.voice_model, (platformCatalog.byte || {}).unavailable_models, false);
            fillModelOptions("ai-ali-model", (platformCatalog.ali || {}).models, ali.model, (platformCatalog.ali || {}).unavailable_models);
            fillModelOptions("ai-ali-audio-model", (platformCatalog.ali || {}).audio_models, ali.audio_model, (platformCatalog.ali || {}).unavailable_models);
            fillModelOptions("ai-ali-voice-model", (platformCatalog.ali || {}).voice_models, ali.voice_model, (platformCatalog.ali || {}).unavailable_models);
          })
          .catch(function () { /* 刷新失败保留内置默认，下次打开仍可用 */ });
      })
      .catch(function (error) {
        document.getElementById("ai-settings-error").textContent = error.message;
        document.getElementById("ai-settings-error").hidden = false;
      });
  });

  // ---------- 角色形象库 ----------

  function renderList(selectedId) {
    var list = document.getElementById("ai-characters-list");
    list.innerHTML = "";
    charactersCache.forEach(function (character) {
      var row = document.createElement("div");
      row.className = "ai-character-row" + (selectedId === character.id ? " selected" : "");
      var thumb = document.createElement("div");
      thumb.className = "ai-character-thumb";
      if (character.image_file) {
        var img = document.createElement("img");
        img.src = character.image_file;
        img.alt = character.name + " 形象图";
        thumb.appendChild(img);
      } else {
        thumb.textContent = "无";
      }
      row.appendChild(thumb);
      var info = document.createElement("div");
      info.className = "ai-character-info";
      var name = document.createElement("strong");
      name.textContent = character.name;
      info.appendChild(name);
      if (character.description) {
        var desc = document.createElement("p");
        desc.textContent = character.description;
        info.appendChild(desc);
      }
      var uses = (character.uses || []).map(function (use) {
        return (use.alias || use.script_title || use.script_id) + (use.alias && use.script_title ? "（" + use.script_title + "）" : "");
      });
      var applied = document.createElement("p");
      applied.className = "help";
      applied.textContent = uses.length ? "已应用：" + uses.join("、") : "尚未在剧本中使用";
      info.appendChild(applied);
      row.appendChild(info);
      row.addEventListener("click", function () { selectCharacter(character.id); });
      list.appendChild(row);
    });
    if (!charactersCache.length) {
      var empty = document.createElement("div");
      empty.className = "ai-task-empty";
      empty.textContent = "还没有角色。先保存一个角色，再生成或上传形象图。";
      list.appendChild(empty);
    }
  }

  function selectCharacter(id) {
    currentId = id;
    var character = charactersCache.find(function (item) { return item.id === id; });
    if (!character) { return; }
    document.getElementById("ai-character-id").value = id;
    document.getElementById("ai-character-name").value = character.name;
    document.getElementById("ai-character-description").value = character.description || "";
    document.getElementById("ai-character-generate").disabled = false;
    document.getElementById("ai-character-delete").disabled = false;
    var preview = document.getElementById("ai-character-preview");
    var img = document.getElementById("ai-character-preview-img");
    if (character.image_file) {
      img.src = character.image_file;
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
    var usesBox = document.getElementById("ai-character-uses");
    var uses = character.uses || [];
    usesBox.textContent = uses.length
      ? "已在这些剧本应用：" + uses.map(function (use) { return use.script_title + (use.alias ? "（别名：" + use.alias + "）" : ""); }).join("；")
      : "尚未在任何剧本中应用。";
    usesBox.hidden = false;
    document.getElementById("ai-character-error").hidden = true;
    renderList(id);
  }

  function clearForm() {
    currentId = null;
    document.getElementById("ai-character-id").value = "";
    document.getElementById("ai-character-name").value = "";
    document.getElementById("ai-character-description").value = "";
    document.getElementById("ai-character-generate").disabled = true;
    document.getElementById("ai-character-delete").disabled = true;
    document.getElementById("ai-character-preview").hidden = true;
    document.getElementById("ai-character-uses").hidden = true;
    document.getElementById("ai-character-error").hidden = true;
    document.getElementById("ai-character-status").textContent = "";
    renderList(null);
  }

  function openCharacters() {
    // 确保平台目录已加载（模型列表），再拉角色库
    var ensureCatalog = Object.keys(platformCatalog).length
      ? Promise.resolve()
      : api("/api/ai/status").then(function (data) { platformCatalog = data.platforms || {}; });
    ensureCatalog.then(function () { return api("/api/ai/characters"); }).then(function (data) {
      charactersCache = data.characters || [];
      clearForm();
      fillCharacterImageModels();
      charactersDialog.showModal();
    }).catch(function (error) {
      document.getElementById("ai-character-error").textContent = error.message;
      document.getElementById("ai-character-error").hidden = false;
    });
  }

  document.getElementById("ai-character-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var payload = {
      name: document.getElementById("ai-character-name").value.trim(),
      description: document.getElementById("ai-character-description").value.trim(),
    };
    if (!payload.name) { return; }
    var path = currentId ? "/api/ai/characters/" + currentId : "/api/ai/characters";
    var method = currentId ? "PUT" : "POST";
    api(path, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function () { return api("/api/ai/characters"); })
      .then(function (data) {
        charactersCache = data.characters || [];
        selectCharacter(currentId || charactersCache[0] && charactersCache[0].id);
      })
      .catch(function (error) {
        document.getElementById("ai-character-error").textContent = error.message;
        document.getElementById("ai-character-error").hidden = false;
      });
  });

  // 填充“形象卡模型”下拉：列出该平台已接入的图像模型，标注免费模型；默认选中保存的图像默认
  function fillCharacterImageModels() {
    var platform = document.getElementById("ai-character-image-platform").value || "mock";
    var meta = platformCatalog[platform] || {};
    var models = meta.image_models || {};
    var sel = document.getElementById("ai-character-image-model");
    // 实测确认未开通的模型不显示；保留可用与尚未验证的
    var blocked = meta.unavailable_models || [];
    var keys = Object.keys(models).filter(function (k) { return blocked.indexOf(k) < 0; });
    if (!keys.length) {
      sel.innerHTML = '<option value="">（暂无可用图像模型：实测过的未开通模型已隐藏，请到设置刷新或开通后重试）</option>';
      return;
    }
    var html = "";
    keys.forEach(function (k) {
      var free = /flash|lite/i.test(k) ? " ⭐免费" : "";
      html += '<option value="' + k + '">' + k + free + "</option>";
    });
    sel.innerHTML = html;
    var savedDefault = meta.image_model || "";
    if (savedDefault && keys.indexOf(savedDefault) >= 0) {
      sel.value = savedDefault;
    }
  }
  document.getElementById("ai-character-image-platform").addEventListener("change", fillCharacterImageModels);

  document.getElementById("ai-character-generate").addEventListener("click", function () {
    if (!currentId) { return; }
    var button = this;
    button.disabled = true;
    var status = document.getElementById("ai-character-status");
    var errorBox = document.getElementById("ai-character-error");
    errorBox.hidden = true;
    var platform = document.getElementById("ai-character-image-platform").value || "mock";
    var platformMeta = platformCatalog[platform] || {};
    var model = document.getElementById("ai-character-image-model").value || "";
    status.textContent = "已提交生成任务（" + (platformMeta.display || platform) + "），正在生成…";
    api("/api/ai/characters/" + currentId + "/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform, model: model, ratio: "1:1" }),
    }).then(function (task) {
      renderAiTasks();
      var taskId = task && task.task_id;
      if (!taskId) { button.disabled = false; return; }
      var poll = setInterval(function () {
        api("/api/ai/tasks/" + taskId).then(function (t) {
          if (!t) { return; }
          if (t.status === "succeeded") {
            clearInterval(poll);
            button.disabled = false;
            api("/api/ai/characters").then(function (data) {
              charactersCache = data.characters || [];
              selectCharacter(currentId);
              status.textContent = "形象图已生成并写入。";
            }).catch(function () {});
            return;
          }
          if (t.status === "failed") {
            clearInterval(poll);
            button.disabled = false;
            status.textContent = "";
            errorBox.textContent = friendlyError(t.error, platform);
            errorBox.hidden = false;
            return;
          }
          status.textContent = "正在生成形象图…（" + (t.progress || 0) + "%）";
        }).catch(function () {});
      }, 1000);
      setTimeout(function () { button.disabled = false; }, 30000);
    }).catch(function (error) {
      button.disabled = false;
      status.textContent = "";
      errorBox.textContent = friendlyError(error.message, platform);
      errorBox.hidden = false;
    });
  });

  document.getElementById("ai-character-upload").addEventListener("change", function () {
    var file = this.files[0];
    if (!file || !currentId) { return; }
    var data = new FormData();
    data.append("file", file);
    api("/api/ai/characters/" + currentId + "/image", { method: "POST", body: data })
      .then(function () { return api("/api/ai/characters"); })
      .then(function (result) {
        charactersCache = result.characters || [];
        selectCharacter(currentId);
        document.getElementById("ai-character-status").textContent = "形象图已更新。";
      })
      .catch(function (error) {
        document.getElementById("ai-character-error").textContent = error.message;
        document.getElementById("ai-character-error").hidden = false;
      });
    this.value = "";
  });

  document.getElementById("ai-character-delete").addEventListener("click", function () {
    if (!currentId) { return; }
    var targetId = currentId;
    // 使用自定义确认框（桌面版对原生 confirm 支持不完整，会阻塞界面）
    piaConfirm("确定删除该角色及其应用记录？").then(function (ok) {
      if (!ok) { return; }
      api("/api/ai/characters/" + targetId, { method: "DELETE" })
        .then(function () { return api("/api/ai/characters"); })
        .then(function (data) {
          charactersCache = data.characters || [];
          clearForm();
        })
        .catch(function (error) {
          document.getElementById("ai-character-error").textContent = error.message;
          document.getElementById("ai-character-error").hidden = false;
        });
    });
  });

  document.getElementById("open-ai-settings").addEventListener("click", openSettings);
  document.getElementById("open-ai-characters").addEventListener("click", openCharacters);
  document.querySelectorAll("[data-ai-settings-close]").forEach(function (button) {
    button.addEventListener("click", function () { settingsDialog.close(); });
  });
  document.querySelectorAll("[data-ai-characters-close]").forEach(function (button) {
    button.addEventListener("click", function () { charactersDialog.close(); });
  });

  // ---------- 任务队列浮层（AI 生成中心，覆盖视频与形象图任务） ----------

  var aiFloat = document.getElementById("ai-task-float");
  var aiFloatBody = document.getElementById("ai-task-float-body");
  var aiFloatCount = document.getElementById("ai-task-float-count");
  var aiFloatToggle = document.getElementById("ai-task-float-toggle");
  var aiFloatClear = document.getElementById("ai-task-float-clear");

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function renderAiTasks() {
    if (!aiFloatBody || !aiFloat) { return; }
    api("/api/ai/tasks?limit=20").then(function (data) {
      var tasks = data.tasks || [];
      aiFloatCount.textContent = String(tasks.length);
      if (!tasks.length) { aiFloatBody.innerHTML = '<div class="ai-task-empty">暂无生成任务。</div>'; return; }
      aiFloatBody.replaceChildren();
      tasks.slice(0, 12).forEach(function (task) {
        var item = document.createElement("div");
        item.className = "ai-task-item";
        var kind = task.kind === "image" ? "形象图" : "视频";
        var platformLabel = task.platform === "mock" ? "模拟" : (task.platform === "byte" ? "字节" : "阿里");
        var statusLabel = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[task.status] || task.status;
        var title = task.prompt ? String(task.prompt).replace(/\s+/g, " ").slice(0, 26) : (kind + " " + task.task_id);
        item.innerHTML = '<div class="ai-task-item-top"><span class="ai-task-item-kind">' + kind + "</span>" +
          '<span class="ai-task-item-title">' + escapeHtml(title) + "</span>" +
          '<span class="ai-task-item-status ' + task.status + '">' + statusLabel + " · " + platformLabel + "</span></div>" +
          '<div class="ai-task-bar"><span style="width:' + Math.max(4, task.progress || 0) + '%"></span></div>';
        if (task.error && task.status === "failed") {
          var err = document.createElement("div");
          err.className = "ai-task-item-error";
          err.textContent = friendlyError(task.error, task.platform);
          item.appendChild(err);
        }
        if (task.status === "failed" || task.status === "cancelled") {
          var actions = document.createElement("div");
          actions.className = "ai-task-item-actions";
          var retry = document.createElement("button");
          retry.type = "button";
          retry.className = "task-retry-button";
          retry.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>重试';
          retry.addEventListener("click", function () {
            api("/api/ai/tasks/" + task.task_id + "/retry", { method: "POST" }).then(renderAiTasks).catch(function () {});
          });
          actions.appendChild(retry);
          item.appendChild(actions);
        }
        aiFloatBody.appendChild(item);
      });
    }).catch(function () {});
  }

  if (aiFloatToggle) {
    aiFloatToggle.addEventListener("click", function () {
      aiFloat.classList.toggle("collapsed");
      aiFloatToggle.textContent = aiFloat.classList.contains("collapsed") ? "▸" : "▾";
    });
  }
  if (aiFloatClear) {
    aiFloatClear.addEventListener("click", function () {
      if (aiFloat.classList.contains("collapsed")) { return; }
      piaConfirm("清除全部「已完成 / 失败 / 已取消」的任务记录？\n排队中和生成中的任务会保留。").then(function (ok) {
        if (!ok) { return; }
        api("/api/ai/tasks/finished", { method: "DELETE" }).then(renderAiTasks).catch(function () {
          piaAlert("清除失败，请重试。");
        });
      });
    });
  }
  // 切换到 AI 生成页签时显示队列浮层并刷新
  var aiTabButton = document.getElementById("tab-ai");
  if (aiTabButton) {
    aiTabButton.addEventListener("click", function () { aiFloat.hidden = false; renderAiTasks(); });
  }
  setInterval(renderAiTasks, 3000);
})();
