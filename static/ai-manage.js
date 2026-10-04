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
    api("/api/ai/config").then(function (data) {
      var config = data.config || {};
      document.getElementById("ai-enabled").checked = !!config.enabled;
      fillRatioOptions(config.default_ratio || "9:16");
      fillDurationOptions(config.default_duration || 10);
      var byte = (config.platforms && config.platforms.byte) || {};
      var ali = (config.platforms && config.platforms.ali) || {};
      document.getElementById("ai-byte-model").value = byte.model || "seedance-1.0-pro";
      document.getElementById("ai-byte-key").value = byte.api_key || "";
      document.getElementById("ai-ali-model").value = ali.model || "wanx2.1-t2v-turbo";
      document.getElementById("ai-ali-key").value = ali.api_key || "";
      document.getElementById("ai-settings-error").hidden = true;
      settingsDialog.showModal();
    }).catch(function (error) {
      document.getElementById("ai-settings-error").textContent = error.message;
      document.getElementById("ai-settings-error").hidden = false;
    });
  }

  document.getElementById("ai-settings-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var payload = {
      enabled: document.getElementById("ai-enabled").checked,
      default_ratio: document.getElementById("ai-default-ratio").value,
      default_duration: parseInt(document.getElementById("ai-default-duration").value, 10),
      platforms: {
        byte: {
          model: document.getElementById("ai-byte-model").value,
          api_key: document.getElementById("ai-byte-key").value.trim(),
        },
        ali: {
          model: document.getElementById("ai-ali-model").value,
          api_key: document.getElementById("ai-ali-key").value.trim(),
        },
      },
    };
    api("/api/ai/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function () { settingsDialog.close(); })
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
    api("/api/ai/characters").then(function (data) {
      charactersCache = data.characters || [];
      clearForm();
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

  document.getElementById("ai-character-generate").addEventListener("click", function () {
    if (!currentId) { return; }
    var button = this;
    button.disabled = true;
    var status = document.getElementById("ai-character-status");
    status.textContent = "已提交生成任务，完成后会自动写入形象图（模拟平台约 3 秒）。";
    api("/api/ai/characters/" + currentId + "/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "mock", ratio: "1:1" }),
    }).then(function () {
      var poll = setInterval(function () {
        api("/api/ai/characters").then(function (data) {
          var character = (data.characters || []).find(function (item) { return item.id === currentId; });
          if (character && character.image_file) {
            clearInterval(poll);
            button.disabled = false;
            charactersCache = data.characters || [];
            selectCharacter(currentId);
            status.textContent = "形象图已生成并写入。";
          }
        }).catch(function () {});
      }, 1000);
      setTimeout(function () { button.disabled = false; }, 20000);
    }).catch(function (error) {
      button.disabled = false;
      status.textContent = "";
      document.getElementById("ai-character-error").textContent = error.message;
      document.getElementById("ai-character-error").hidden = false;
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
    if (!window.confirm("确定删除该角色及其应用记录？")) { return; }
    api("/api/ai/characters/" + currentId, { method: "DELETE" })
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

  document.getElementById("open-ai-settings").addEventListener("click", openSettings);
  document.getElementById("open-ai-characters").addEventListener("click", openCharacters);
  document.querySelectorAll("[data-ai-settings-close]").forEach(function (button) {
    button.addEventListener("click", function () { settingsDialog.close(); });
  });
  document.querySelectorAll("[data-ai-characters-close]").forEach(function (button) {
    button.addEventListener("click", function () { charactersDialog.close(); });
  });
})();
