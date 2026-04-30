// ============================================================
// service-worker.js —— 后台脚本（Service Worker）
//
// 职责：
//   1. 扩展安装/更新时的初始化，确保 storage 中存在所需键
//   2. 点击扩展图标时，向当前页面注入浮层 content script
//   3. 监听取色完成消息，自动打开 popup 结果窗口
// ============================================================

// ========== 1. 安装/更新初始化 ==========
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === "install") {
    chrome.storage.local.set({
      colorHistory: [],
      savedColors: [],
    });
  }
  if (details.reason === "update") {
    chrome.storage.local.get(["colorHistory", "savedColors"], function (result) {
      var updates = {};
      if (!result.colorHistory) updates.colorHistory = [];
      if (!result.savedColors) updates.savedColors = [];
      if (Object.keys(updates).length > 0) {
        chrome.storage.local.set(updates);
      }
    });
  }
});

// ========== 2. 点击扩展图标 → 注入浮层 ==========
chrome.action.onClicked.addListener(function (tab) {
  // 向当前标签页注入浮层脚本
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOAT_PANEL" }, function (response) {
    if (chrome.runtime.lastError) {
      // content script 未加载，尝试注入
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/content.js"],
      }, function () {
        if (chrome.runtime.lastError) {
          console.error("[BG] 注入失败:", chrome.runtime.lastError);
          return;
        }
        // 注入成功后再次发送消息
        setTimeout(function () {
          chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOAT_PANEL" });
        }, 100);
      });
    }
  });
});

// ========== 3. 消息监听 ==========
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // ---- 3a. 取色开始：background 执行截图，将数据发回 content script ----
  if (message.type === "PICKER_STARTED") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, function (dataUrl) {
      if (chrome.runtime.lastError || !dataUrl) {
        console.error("[BG] 截图失败:", chrome.runtime.lastError);
        sendResponse({ ok: false, error: "capture failed" });
        return;
      }
      // 将截图数据发回 content script
      chrome.tabs.sendMessage(sender.tab.id, {
        type: "PICKER_READY",
        dataUrl: dataUrl
      });
      sendResponse({ ok: true });
    });
    return true; // 异步响应
  }

  // ---- 3b. 取色完成：保存结果到 storage（浮层由 content script 自行显示） ----
  if (message.type === "PICKER_COMPLETE") {
    // 保存取色结果到 storage
    chrome.storage.local.set({
      pickedColor: message.color,
      pickedColorNew: true
    });

    sendResponse({ ok: true });
    return true;
  }

  return false;
});
