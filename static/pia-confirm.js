/* 通用确认/提示对话框（替代 window.confirm / window.alert）。
 * 桌面版（WebView / pywebview）对原生 JS 对话框支持不完整，模态阻塞会导致界面按钮卡死；
 * 此模块使用 HTML5 <dialog>，桌面版与浏览器均原生支持。
 * 用法：
 *   piaConfirm("要删除吗？").then(function (ok) { if (ok) { ... } });
 *   piaAlert("已删除。");
 */
(function () {
  "use strict";
  var dialog = document.getElementById("pia-confirm-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "pia-confirm-dialog";
    dialog.className = "dialog pia-confirm-dialog";
    dialog.innerHTML =
      '<div class="dialog-heading"><div><span class="eyebrow">CONFIRM</span><h2 id="pia-confirm-title">确认操作</h2></div>' +
      '<button type="button" class="icon-button" data-pia-confirm-cancel aria-label="关闭">×</button></div>' +
      '<p id="pia-confirm-message" style="white-space:pre-line;line-height:1.6;color:#4a443c;font-size:14px;margin:6px 0 14px;"></p>' +
      '<div class="dialog-actions"><button type="button" class="button secondary" data-pia-confirm-cancel>取消</button>' +
      '<button type="button" class="button primary" data-pia-confirm-ok>确认</button></div>';
    document.body.appendChild(dialog);
  }
  var okBtn = dialog.querySelector("[data-pia-confirm-ok]");
  var cancelBtns = dialog.querySelectorAll("[data-pia-confirm-cancel]");
  var titleEl = document.getElementById("pia-confirm-title");
  var messageEl = document.getElementById("pia-confirm-message");
  var okLabel = okBtn.textContent;
  var resolver = null;
  var alertMode = false;

  function settle(value) {
    if (!resolver) { return; }
    var resolve = resolver;
    resolver = null;
    dialog.close();
    resolve(value);
  }
  okBtn.addEventListener("click", function () { settle(alertMode ? true : true); });
  cancelBtns.forEach(function (button) {
    button.addEventListener("click", function () { settle(alertMode ? true : false); });
  });
  dialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    settle(alertMode ? true : false);
  });
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) { settle(alertMode ? true : false); }
  });

  function show(message, title, isAlert) {
    alertMode = !!isAlert;
    titleEl.textContent = title || (isAlert ? "提示" : "确认操作");
    messageEl.textContent = message || "";
    // alert 模式：只保留“确认”按钮
    okBtn.textContent = isAlert ? "知道了" : okLabel;
    cancelBtns.forEach(function (button) { button.hidden = isAlert; });
    return new Promise(function (resolve) {
      resolver = resolve;
      dialog.showModal();
    });
  }

  window.piaConfirm = function (message, title) { return show(message, title, false); };
  window.piaAlert = function (message, title) { return show(message, title, true); };
})();
