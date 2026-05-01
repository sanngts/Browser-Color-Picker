// ============================================================
// service-worker.js —— 后台脚本（Service Worker）
//
// 职责：
//   1. 扩展安装/更新时的初始化，确保 storage 中存在所需键
//   2. 根据当前标签页 URL 判断是否受限页面，动态设置/清除 popup
//   3. 点击扩展图标时，向当前页面注入浮层 content script
//   4. 监听取色完成消息，同步存储取色结果
// ============================================================

// ========== 受限页面 URL 匹配规则 ==========
// 这些页面浏览器内核层面禁止内容脚本注入，必须使用 popup 模式
var RESTRICTED_PATTERNS = [
  /^https?:\/\/microsoftedge\.microsoft\.com\/addons\//i,
  /^https?:\/\/chromewebstore\.google\.com\//i,
  /^chrome:\/\/.*/i,
  /^edge:\/\/.*/i,
  /^chrome-extension:\/\/.*/i,
  /^edge-extension:\/\/.*/i,
  /^about:.*/i,
  /^devtools:\/\/.*/i,
];

/**
 * 判断当前 URL 是否为受限页面（浏览器禁止注入内容脚本的页面）
 * @param {string} url - 标签页 URL
 * @returns {boolean}
 */
function isRestrictedUrl(url) {
  if (!url) return false;
  return RESTRICTED_PATTERNS.some(function (pattern) {
    return pattern.test(url);
  });
}

/**
 * 根据标签页 URL 动态设置或清除 popup
 * 受限页面 → 设置 popup 为 popup.html（点击图标打开下拉面板）
 * 普通页面 → 清除 popup（点击图标触发 onClicked 事件，注入浮层）
 * @param {chrome.tabs.Tab} tab - 标签页对象
 */
function updatePopupForTab(tab) {
  if (!tab.id || !tab.url) return;

  if (isRestrictedUrl(tab.url)) {
    chrome.action.setPopup({ tabId: tab.id, popup: "popup/popup.html" });
  } else {
    chrome.action.setPopup({ tabId: tab.id, popup: "" });
  }
}

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

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) {
      updatePopupForTab(tabs[0]);
    }
  });
});

// ========== 2. 标签页切换/导航监听 → 动态设置 popup ==========

chrome.tabs.onActivated.addListener(function (activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function (tab) {
    if (chrome.runtime.lastError || !tab) return;
    updatePopupForTab(tab);
  });
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status === "loading" || changeInfo.url) {
    updatePopupForTab(tab);
  }
});

// ========== 3. 点击扩展图标 → 注入浮层（仅普通页面） ==========
chrome.action.onClicked.addListener(function (tab) {
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOAT_PANEL" }, function (response) {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/content.js"],
      }, function () {
        if (chrome.runtime.lastError) {
          console.error("[BG] 注入失败:", chrome.runtime.lastError);
          return;
        }
        setTimeout(function () {
          chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOAT_PANEL" }, function (resp) {
            if (chrome.runtime.lastError) {
              console.error("[BG] 注入后发送消息失败:", chrome.runtime.lastError);
            }
          });
        }, 200);
      });
    }
  });
});

// ========== 4. 消息监听 ==========
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === "PICKER_STARTED") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, function (dataUrl) {
      if (chrome.runtime.lastError || !dataUrl) {
        console.error("[BG] 截图失败:", chrome.runtime.lastError);
        sendResponse({ ok: false, error: "capture failed" });
        return;
      }
      chrome.tabs.sendMessage(sender.tab.id, {
        type: "PICKER_READY",
        dataUrl: dataUrl
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "PICKER_COMPLETE") {
    chrome.storage.local.set({
      pickedColor: message.color,
      pickedColorNew: true
    });
    sendResponse({ ok: true });
    return true;
  }

  // EyeDropper 取色结果（受限页面降级方案）
  // popup 被 EyeDropper 关闭后，通过 background 可靠保存颜色
  if (message.type === "PICK_RESULT") {
    chrome.storage.local.set({
      pickedColor: message.color,
      pickedColorNew: true
    });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});