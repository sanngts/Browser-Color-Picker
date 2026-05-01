// ============================================================
// content.js —— 内容脚本（取色器核心 + 浮层界面）
//
// 职责：
//   1. 浮层管理：创建/显示/隐藏自定义浮层（Shadow DOM 隔离样式）
//   2. 取色器核心：接收截图数据，创建取色器 overlay，
//      处理鼠标移动/点击事件，实现放大镜预览和颜色拾取
//   3. 数据管理：颜色历史、收藏夹的持久化存储
//
// 消息协议：
//   background → content: { type: "TOGGLE_FLOAT_PANEL" }
//   content → background: { type: "PICKER_COMPLETE", color: "#RRGGBB" }
// ============================================================

// ========== 常量配置 ==========
var PAGE_SIZE = 5;
var MAX_HISTORY = 10;
var MAX_FAVORITES = 12;

// ========== 浮层相关状态 ==========
var floatPanelHost = null;
var floatPanelRoot = null;
var floatPanelVisible = false;

// ========== 取色器相关状态 ==========
var pickerActive = false;
var capturedCanvas = null;
var overlayEl = null;
var magnifierEl = null;
var magnifierCanvas = null;
var magnifierCtx = null;
var sourceDpr = 1;

var ZOOM = 10;
var LENS_SIZE = 150;
var CURSOR_OFFSET = 20;

// ========== 浮层 DOM 引用 ==========
var fp = {};

// ========== 浮层数据状态 ==========
var currentPage = 0;
var colorHistory = [];
var savedColors = [];
var colors = { hex: '', rgb: '', hsl: '', hsv: '' };

// ============================================================
// 消息监听
// ============================================================
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === "TOGGLE_FLOAT_PANEL") {
    if (floatPanelVisible) {
      hideFloatPanel();
    } else {
      showFloatPanel();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PICKER_READY") {
    // background 截图完成，发回了截图数据
    try {
      sourceDpr = window.devicePixelRatio || 1;
      initPicker(message.dataUrl);
      resetPickBtn();
    } catch (err) {
      console.error("[颜色拾取器] 初始化失败:", err);
      resetPickBtn();
    }
    return false;
  }

  if (message.type === "START_PICKER") {
    if (pickerActive) {
      sendResponse({ ok: true, status: "already_active" });
      return false;
    }
    try {
      sourceDpr = window.devicePixelRatio || 1;
      initPicker(message.dataUrl);
      sendResponse({ ok: true, status: "started" });
    } catch (err) {
      console.error("[颜色拾取器] 初始化失败:", err);
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }

  return true;
});

// ============================================================
// 浮层管理
// ============================================================

function createFloatPanel() {
  if (floatPanelHost) return;

  floatPanelHost = document.createElement("div");
  floatPanelHost.id = "__cp_float_host__";

  floatPanelRoot = floatPanelHost.attachShadow({ mode: "closed" });

  var style = document.createElement("style");
  style.textContent = getFloatPanelCSS();
  floatPanelRoot.appendChild(style);

  var panel = document.createElement("div");
  panel.className = "cp-float-panel";
  panel.innerHTML = getFloatPanelHTML();
  floatPanelRoot.appendChild(panel);

  fp.panel = panel;
  fp.colorPreview = panel.querySelector("#cp-colorPreview");
  fp.btnHex = panel.querySelector("#cp-btnHex");
  fp.btnRgb = panel.querySelector("#cp-btnRgb");
  fp.btnHsl = panel.querySelector("#cp-btnHsl");
  fp.btnHsv = panel.querySelector("#cp-btnHsv");
  fp.btnPick = panel.querySelector("#cp-btnPick");
  fp.btnPageLeft = panel.querySelector("#cp-btnPageLeft");
  fp.btnPageRight = panel.querySelector("#cp-btnPageRight");
  fp.historyList = panel.querySelector("#cp-historyList");
  fp.btnClearHistory = panel.querySelector("#cp-btnClearHistory");
  fp.btnSave = panel.querySelector("#cp-btnSave");
  fp.favoriteList = panel.querySelector("#cp-favoriteList");
  fp.favoriteCount = panel.querySelector("#cp-favoriteCount");
  fp.btnClearFavorites = panel.querySelector("#cp-btnClearFavorites");
  fp.previewText = panel.querySelector("#cp-previewText");
  fp.closeBtn = panel.querySelector("#cp-closeBtn");

  bindFloatPanelEvents();

  document.documentElement.appendChild(floatPanelHost);
}

function showFloatPanel() {
  createFloatPanel();
  floatPanelVisible = true;
  // 先确保浮层可见（但位置在右侧外部），再触发 transition 滑入
  fp.panel.style.display = "flex";
  // 强制浏览器回流，使 display 变更生效后再添加 visible 类触发动画
  void fp.panel.offsetHeight;
  fp.panel.classList.add("cp-float-panel--visible");
  loadDataAndUpdate();
}

function hideFloatPanel(callback) {
  floatPanelVisible = false;
  if (fp.panel) {
    // 移除 visible 类 → 触发 transition 滑出到右侧
    fp.panel.classList.remove("cp-float-panel--visible");
    // 等待动画结束后再隐藏 display，并执行回调
    setTimeout(function () {
      if (!floatPanelVisible && fp.panel) {
        fp.panel.style.display = "none";
      }
      if (typeof callback === "function") {
        callback();
      }
    }, 300);
  } else if (typeof callback === "function") {
    callback();
  }
}

function loadDataAndUpdate() {
  chrome.storage.local.get(["pickedColor", "pickedColorNew", "colorHistory", "savedColors"], function (result) {
    savedColors = result.savedColors || [];
    renderFavorites();

    colorHistory = result.colorHistory || [];
    renderHistoryPage();

    if (result.pickedColorNew && result.pickedColor) {
      updateColorInfo(result.pickedColor, true);
      copyColorToClipboard('hex', true);
      chrome.storage.local.set({ pickedColorNew: false });
    } else if (result.pickedColor) {
      updateColorInfo(result.pickedColor, false);
    } else if (colorHistory.length > 0) {
      updateColorInfo(colorHistory[0], false);
    } else {
      resetColorPreview();
    }
  });
}

function bindFloatPanelEvents() {
  fp.closeBtn.addEventListener("click", function () {
    hideFloatPanel();
  });

  fp.btnPick.addEventListener("click", function () {
    // 先触发浮层滑出动画，等待动画完成后再启动截图
    hideFloatPanel(function () {
      startPickerFromFloatPanel();
    });
  });

  fp.btnHex.addEventListener("click", function () { copyColorToClipboard('hex'); });
  fp.btnRgb.addEventListener("click", function () { copyColorToClipboard('rgb'); });
  fp.btnHsl.addEventListener("click", function () { copyColorToClipboard('hsl'); });
  fp.btnHsv.addEventListener("click", function () { copyColorToClipboard('hsv'); });

  fp.btnSave.addEventListener("click", function () {
    if (!colors.hex || fp.btnSave.disabled) return;
    var index = savedColors.indexOf(colors.hex);
    if (index !== -1) {
      savedColors.splice(index, 1);
    } else {
      if (savedColors.length >= MAX_FAVORITES) return;
      savedColors.unshift(colors.hex);
    }
    renderFavorites();
    updateSaveBtnState();
    chrome.storage.local.set({ savedColors: savedColors });
  });

  fp.btnClearFavorites.addEventListener("click", function () {
    savedColors = [];
    renderFavorites();
    chrome.storage.local.set({ savedColors: [] });
    updateSaveBtnState();
  });

  fp.btnClearHistory.addEventListener("click", function () {
    colorHistory = [];
    currentPage = 0;
    renderHistoryPage();
    chrome.storage.local.set({ colorHistory: [], pickedColor: '', pickedColorNew: false });
    resetColorPreview();
  });

  fp.btnPageLeft.addEventListener("click", function () {
    if (currentPage > 0) {
      currentPage--;
      renderHistoryPage();
    }
  });
  fp.btnPageRight.addEventListener("click", function () {
    var totalPages = Math.ceil(colorHistory.length / PAGE_SIZE);
    if (currentPage < totalPages - 1) {
      currentPage++;
      renderHistoryPage();
    }
  });
}

// ============================================================
// 从浮层启动取色
// ============================================================
function startPickerFromFloatPanel() {
  fp.btnPick.disabled = true;
  fp.btnPick.textContent = 'Capturing...';

  // 发送消息给 background，让 background 执行截图
  chrome.runtime.sendMessage({ type: "PICKER_STARTED" }, function (response) {
    if (chrome.runtime.lastError || !response || !response.ok) {
      console.error("[Pick] 启动取色失败:", chrome.runtime.lastError);
      resetPickBtn();
    }
    // 截图完成后 background 会发送 PICKER_READY 消息回来
    // 在消息监听中处理 PICKER_READY
  });
}

function resetPickBtn() {
  if (fp.btnPick) {
    fp.btnPick.disabled = false;
    fp.btnPick.textContent = 'Pick';
  }
}

// ============================================================
// 取色器核心逻辑
// ============================================================

function initPicker(dataUrl) {
  pickerActive = true;

  var img = new Image();
  img.onload = function () {
    capturedCanvas = document.createElement("canvas");
    capturedCanvas.width = img.naturalWidth;
    capturedCanvas.height = img.naturalHeight;
    var ctx = capturedCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    createPickerUI();
  };

  img.onerror = function () {
    console.error("[颜色拾取器] 截图图片加载失败");
    pickerActive = false;
  };

  img.src = dataUrl;
}

function createPickerUI() {
  overlayEl = document.createElement("div");
  overlayEl.id = "__cp_overlay__";
  Object.assign(overlayEl.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    cursor: buildCrosshairCursor(),
  });

  magnifierEl = document.createElement("div");
  magnifierEl.id = "__cp_magnifier__";
  Object.assign(magnifierEl.style, {
    position: "fixed",
    width: (LENS_SIZE + 16) + "px",
    height: (LENS_SIZE + 16) + "px",
    borderRadius: "10px",
    overflow: "hidden",
    pointerEvents: "none",
    display: "none",
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    background: "#fff",
    padding: "8px",
    opacity: "0",
    transition: "opacity 0.12s ease",
    zIndex: "999999999",
  });

  var lensWrapper = document.createElement("div");
  Object.assign(lensWrapper.style, {
    width: LENS_SIZE + "px",
    height: LENS_SIZE + "px",
    borderRadius: "50%",
    overflow: "hidden",
    border: "2px solid rgba(255,255,255,0.95)",
    boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.1)",
    position: "relative",
  });

  magnifierCanvas = document.createElement("canvas");
  magnifierCanvas.width = LENS_SIZE;
  magnifierCanvas.height = LENS_SIZE;
  magnifierCtx = magnifierCanvas.getContext("2d", { willReadFrequently: true });
  Object.assign(magnifierCanvas.style, {
    display: "block",
    width: LENS_SIZE + "px",
    height: LENS_SIZE + "px",
    imageRendering: "pixelated",
  });

  lensWrapper.appendChild(magnifierCanvas);
  magnifierEl.appendChild(lensWrapper);

  document.documentElement.appendChild(overlayEl);
  overlayEl.appendChild(magnifierEl);

  overlayEl.addEventListener("mousemove", handleMouseMove, true);
  overlayEl.addEventListener("click", handleClick, true);
  overlayEl.addEventListener("contextmenu", handleRightClick, true);
  document.addEventListener("keydown", handleKeyDown, true);
}

function buildCrosshairCursor() {
  var svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='21' height='21'>" +
    "<line x1='10' y1='0' x2='10' y2='7' stroke='white' stroke-width='2.5'/>" +
    "<line x1='10' y1='13' x2='10' y2='20' stroke='white' stroke-width='2.5'/>" +
    "<line x1='0' y1='10' x2='7' y2='10' stroke='white' stroke-width='2.5'/>" +
    "<line x1='13' y1='10' x2='20' y2='10' stroke='white' stroke-width='2.5'/>" +
    "<line x1='10' y1='0' x2='10' y2='7' stroke='black' stroke-width='1'/>" +
    "<line x1='10' y1='13' x2='10' y2='20' stroke='black' stroke-width='1'/>" +
    "<line x1='0' y1='10' x2='7' y2='10' stroke='black' stroke-width='1'/>" +
    "<line x1='13' y1='10' x2='20' y2='10' stroke='black' stroke-width='1'/>" +
    "</svg>";
  return "url(\"data:image/svg+xml," + svg + "\") 10 10, crosshair";
}

function handleMouseMove(e) {
  if (!pickerActive || !capturedCanvas) return;

  var x = e.clientX;
  var y = e.clientY;

  var pixelX = Math.round(x * sourceDpr);
  var pixelY = Math.round(y * sourceDpr);

  pixelX = Math.max(0, Math.min(pixelX, capturedCanvas.width - 1));
  pixelY = Math.max(0, Math.min(pixelY, capturedCanvas.height - 1));

  drawMagnifiedView(pixelX, pixelY);
  positionMagnifier(x, y);

  magnifierEl.style.display = "block";
  requestAnimationFrame(function () {
    magnifierEl.style.opacity = "1";
  });
}

function readPixelColor(px, py) {
  var ctx = capturedCanvas.getContext("2d", { willReadFrequently: true });
  var data = ctx.getImageData(px, py, 1, 1).data;
  return rgbToHex(data[0], data[1], data[2]);
}

function rgbToHex(r, g, b) {
  return "#" +
    [r, g, b].map(function (v) {
      return v.toString(16).padStart(2, "0");
    }).join("").toUpperCase();
}

function drawMagnifiedView(centerPx, centerPy) {
  var size = LENS_SIZE;
  var srcSize = size / ZOOM;
  var srcX = centerPx - srcSize / 2;
  var srcY = centerPy - srcSize / 2;

  magnifierCtx.imageSmoothingEnabled = false;
  magnifierCtx.clearRect(0, 0, size, size);
  magnifierCtx.drawImage(
    capturedCanvas,
    srcX, srcY, srcSize, srcSize,
    0, 0, size, size
  );

  var half = size / 2;
  var pxSize = ZOOM;

  magnifierCtx.strokeStyle = "rgba(255,255,255,0.95)";
  magnifierCtx.lineWidth = 2;
  magnifierCtx.strokeRect(half - pxSize / 2, half - pxSize / 2, pxSize, pxSize);

  magnifierCtx.strokeStyle = "rgba(0,0,0,0.5)";
  magnifierCtx.lineWidth = 1;
  magnifierCtx.strokeRect(
    half - pxSize / 2 - 1.5,
    half - pxSize / 2 - 1.5,
    pxSize + 3,
    pxSize + 3
  );
}

function positionMagnifier(cursorX, cursorY) {
  var magW = LENS_SIZE + 16;
  var magH = LENS_SIZE + 16;
  var gap = CURSOR_OFFSET;
  var vw = window.innerWidth;
  var vh = window.innerHeight;

  var left = cursorX + gap;
  var top = cursorY - gap - magH;

  if (left + magW > vw - 8) {
    left = cursorX - gap - magW;
  }
  if (top < 8) {
    top = cursorY + gap;
  }
  if (left < 8) {
    left = Math.min(cursorX + gap, vw - magW - 8);
    top = cursorY + gap;
  }

  magnifierEl.style.left = left + "px";
  magnifierEl.style.top = top + "px";
}

function handleClick(e) {
  if (!pickerActive || !capturedCanvas) return;

  var pixelX = Math.round(e.clientX * sourceDpr);
  var pixelY = Math.round(e.clientY * sourceDpr);
  pixelX = Math.max(0, Math.min(pixelX, capturedCanvas.width - 1));
  pixelY = Math.max(0, Math.min(pixelY, capturedCanvas.height - 1));

  var hex = readPixelColor(pixelX, pixelY);

  chrome.storage.local.set({ pickedColor: hex, pickedColorNew: true });

  chrome.runtime.sendMessage({
    type: "PICKER_COMPLETE",
    color: hex
  });

  magnifierEl.style.boxShadow = "0 0 0 3px " + hex + ", 0 4px 24px rgba(0,0,0,0.45)";
  setTimeout(function () {
    cleanupPicker();
    showFloatPanel();
  }, 120);
}

function handleRightClick(e) {
  e.preventDefault();
  cleanupPicker();
}

function handleKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cleanupPicker();
  }
}

function cleanupPicker() {
  pickerActive = false;

  if (overlayEl) {
    overlayEl.removeEventListener("mousemove", handleMouseMove, true);
    overlayEl.removeEventListener("click", handleClick, true);
    overlayEl.removeEventListener("contextmenu", handleRightClick, true);
    overlayEl.remove();
    overlayEl = null;
  }
  if (magnifierEl) {
    magnifierEl.remove();
    magnifierEl = null;
  }

  document.removeEventListener("keydown", handleKeyDown, true);

  capturedCanvas = null;
  magnifierCanvas = null;
  magnifierCtx = null;
}

// ============================================================
// 浮层 UI 更新函数
// ============================================================

function updateColorInfo(hex, addToHistory) {
  if (addToHistory === undefined) addToHistory = true;
  var rgb = hexToRgb(hex);
  var hsl = rgbToHsl(rgb);
  var hsv = rgbToHsv(rgb);
  colors = { hex: hex, rgb: rgb, hsl: hsl, hsv: hsv };

  fp.btnHex.textContent = "HEX: " + hex;
  fp.btnRgb.textContent = "RGB: " + rgb.r + ", " + rgb.g + ", " + rgb.b;
  fp.btnHsl.textContent = "HSL: " + hsl.h + ", " + hsl.s + "%, " + hsl.l + "%";
  fp.btnHsv.textContent = "HSV: " + hsv.h + ", " + hsv.s + "%, " + hsv.v + "%";

  fp.colorPreview.style.backgroundColor = hex;
  fp.previewText.style.display = "none";

  if (addToHistory) {
    addHistoryColor(hex);
  }

  updateSaveBtnState();
}

function hexToRgb(hex) {
  var num = parseInt(hex.slice(1), 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function rgbToHsl(rgb) {
  var rn = rgb.r / 255, gn = rgb.g / 255, bn = rgb.b / 255;
  var max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  var l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  var d = max - min;
  var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  var h;
  switch (max) {
    case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
    case gn: h = ((bn - rn) / d + 2) / 6; break;
    default:  h = ((rn - gn) / d + 4) / 6; break;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function rgbToHsv(rgb) {
  var rn = rgb.r / 255, gn = rgb.g / 255, bn = rgb.b / 255;
  var max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  var v = max;
  if (max === min) return { h: 0, s: 0, v: Math.round(v * 100) };
  var d = max - min;
  var s = d / max;
  var h;
  switch (max) {
    case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
    case gn: h = ((bn - rn) / d + 2) / 6; break;
    default:  h = ((rn - gn) / d + 4) / 6; break;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    v: Math.round(v * 100),
  };
}

function fallbackCopyToClipboard(text) {
  var textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch (e) {}
  document.body.removeChild(textarea);
}

function copyColorToClipboard(colorCode, showFeedback) {
  if (showFeedback === undefined) showFeedback = true;
  if (!colors.hex) return;

  var text = "";
  if (colorCode === "hex") {
    text = colors.hex;
  } else if (colorCode === "rgb") {
    text = colors.rgb.r + ", " + colors.rgb.g + ", " + colors.rgb.b;
  } else if (colorCode === "hsl") {
    text = colors.hsl.h + ", " + colors.hsl.s + "%, " + colors.hsl.l + "%";
  } else if (colorCode === "hsv") {
    text = colors.hsv.h + ", " + colors.hsv.s + "%, " + colors.hsv.v + "%";
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function () {
      fallbackCopyToClipboard(text);
    });
  } else {
    fallbackCopyToClipboard(text);
  }

  if (showFeedback) {
    fp.btnPick.textContent = "Copied!";
    setTimeout(function () {
      fp.btnPick.textContent = "Pick";
    }, 1000);
  }
}

function renderHistoryPage() {
  fp.historyList.innerHTML = "";

  var start = currentPage * PAGE_SIZE;
  var pageItems = colorHistory.slice(start, start + PAGE_SIZE);

  pageItems.forEach(function (hex) {
    var li = document.createElement("li");
    li.className = "cp-history-item";
    li.title = hex;
    li.style.backgroundColor = hex;
    li.addEventListener("click", function () { updateColorInfo(hex, false); });
    fp.historyList.appendChild(li);
  });

  var totalPages = Math.ceil(colorHistory.length / PAGE_SIZE);
  fp.btnPageLeft.disabled = currentPage <= 0;
  fp.btnPageRight.disabled = currentPage >= totalPages - 1;
}

function addHistoryColor(hex) {
  if (colorHistory.length > 0 && colorHistory[0] === hex) return;

  colorHistory.unshift(hex);
  if (colorHistory.length > MAX_HISTORY) {
    colorHistory.pop();
  }

  currentPage = 0;
  renderHistoryPage();
  chrome.storage.local.set({ colorHistory: colorHistory });
}

function renderFavorites() {
  fp.favoriteList.innerHTML = "";

  if (savedColors.length === 0) {
    var hint = document.createElement("p");
    hint.className = "cp-hint";
    hint.textContent = "No favorites";
    fp.favoriteList.appendChild(hint);
  } else {
    savedColors.forEach(function (color, index) {
      var item = document.createElement("div");
      item.className = "cp-fav-item";
      item.style.backgroundColor = color;
      item.title = color;

      item.addEventListener("click", function (e) {
        if (e.target.classList.contains("cp-fav-delete")) return;
        updateColorInfo(color, false);
      });

      var deleteBtn = document.createElement("button");
      deleteBtn.className = "cp-fav-delete";
      deleteBtn.textContent = "\u00d7";
      deleteBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        savedColors.splice(index, 1);
        renderFavorites();
        updateSaveBtnState();
        chrome.storage.local.set({ savedColors: savedColors });
      });

      item.appendChild(deleteBtn);
      fp.favoriteList.appendChild(item);
    });
  }

  updateFavoriteCount();
}

function updateSaveBtnState() {
  if (!colors.hex) return;
  var isSaved = savedColors.indexOf(colors.hex) !== -1;
  if (isSaved) {
    fp.btnSave.innerHTML = "\u2605 Favorited";
    fp.btnSave.classList.add("cp-btn--saved");
    fp.btnSave.title = "Remove from favorites";
  } else {
    fp.btnSave.innerHTML = "\u2606 Favorite";
    fp.btnSave.classList.remove("cp-btn--saved");
    fp.btnSave.title = "Add to favorites";
  }
  fp.btnSave.disabled = !isSaved && savedColors.length >= MAX_FAVORITES;
}

function updateFavoriteCount() {
  fp.favoriteCount.textContent = savedColors.length + "/" + MAX_FAVORITES;
}

function resetColorPreview() {
  colors = { hex: "", rgb: "", hsl: "", hsv: "" };

  fp.btnHex.textContent = "HEX: ";
  fp.btnRgb.textContent = "RGB: ";
  fp.btnHsl.textContent = "HSL: ";
  fp.btnHsv.textContent = "HSV: ";

  fp.colorPreview.style.backgroundColor = "#ffffff";
  fp.previewText.style.display = "";

  fp.btnSave.innerHTML = "\u2606 Favorite";
  fp.btnSave.classList.remove("cp-btn--saved");
  fp.btnSave.disabled = false;
  fp.btnSave.title = "Add to favorites";
}

// ============================================================
// 浮层 HTML 模板
// ============================================================
function getFloatPanelHTML() {
  return [
    '<div class="cp-header">',
    '  <img class="cp-logo" src="' + chrome.runtime.getURL("icons/icon-48.png") + '" alt="Logo">',
    '  <span class="cp-title">Browser Color Picker</span>',
    '  <a href="https://github.com/sanngts/Browser-Color-Picker" class="cp-github" target="_blank" rel="noopener noreferrer" title="Opensource on GitHub">',
    '    <svg class="cp-github-icon" viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">',
    '      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>',
    '    </svg>',
    '  </a>',
    '  <button class="cp-close-btn" id="cp-closeBtn" title="Close">&times;</button>',
    '</div>',

    '<div class="cp-card cp-card--info">',
    '  <div class="cp-card-content cp-card-content--narrow">',
    '    <button class="cp-btn" id="cp-btnHex">HEX: </button>',
    '    <button class="cp-btn" id="cp-btnRgb">RGB: </button>',
    '    <button class="cp-btn" id="cp-btnHsl">HSL: </button>',
    '    <button class="cp-btn" id="cp-btnHsv">HSV: </button>',
    '    <button class="cp-btn cp-btn--save" id="cp-btnSave" title="Add to favorites">&#9734; Favorite</button>',
    '  </div>',
    '  <div class="cp-preview" id="cp-colorPreview">',
    '    <p class="cp-preview-text" id="cp-previewText">Preview</p>',
    '  </div>',
    '</div>',

    '<div class="cp-card cp-card--history">',
    '  <div class="cp-card-content">',
    '    <div class="cp-fav-header">',
    '      <p class="cp-title-text">Recent:</p>',
    '      <span class="cp-fav-count" style="visibility:hidden;">&nbsp;</span>',
    '      <button class="cp-fav-clear" id="cp-btnClearHistory" title="Clear all">Clear</button>',
    '    </div>',
    '    <div class="cp-pagination">',
    '      <button class="cp-page-btn" id="cp-btnPageLeft" title="Prev">&lsaquo;</button>',
    '      <ul class="cp-history-list" id="cp-historyList"></ul>',
    '      <button class="cp-page-btn" id="cp-btnPageRight" title="Next">&rsaquo;</button>',
    '    </div>',
    '  </div>',
    '</div>',

    '<div class="cp-card cp-card--favorites">',
    '  <div class="cp-card-content">',
    '    <div class="cp-fav-header">',
    '      <p class="cp-title-text">Favorites:</p>',
    '      <span class="cp-fav-count" id="cp-favoriteCount">0/12</span>',
    '      <button class="cp-fav-clear" id="cp-btnClearFavorites" title="Clear all">Clear</button>',
    '    </div>',
    '    <div class="cp-fav-list" id="cp-favoriteList">',
    '      <p class="cp-hint">No favorites</p>',
    '    </div>',
    '  </div>',
    '</div>',

    '<div class="cp-footer">',
    '  <button class="cp-pick-btn" id="cp-btnPick">Pick</button>',
    '</div>'
  ].join('\n');
}

// ============================================================
// 浮层 CSS（Shadow DOM 内联样式，完全隔离，加载迅速）
// ============================================================
function getFloatPanelCSS() {
  return [
    '* { margin:0; padding:0; box-sizing:border-box; -webkit-font-smoothing:antialiased; }',

    '.cp-float-panel {',
    '  position: fixed;',
    '  top: 10px;',
    '  right: 10px;',
    '  width: 260px;',
    '  background: #fcfcfc;',
    '  border-radius: 8px;',
    '  box-shadow: 0 4px 24px rgba(0,0,0,0.18);',
    '  z-index: 2147483647;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
    '  font-size: 14px;',
    '  color: #333;',
    '  padding: 10px 8px 10px 8px;',
    '  user-select: none;',
    '  flex-direction: column;',
    '  gap: 10px;',
    '  max-height: 90vh;',
    '  overflow-y: auto;',
    /* 默认隐藏：不可见 + 透明 + 向右平移自身宽度 + 20px 间距 */
    '  visibility: hidden;',
    '  opacity: 0;',
    '  transform: translateX(calc(100% + 20px));',
    /* 匀速动画：transform 和 opacity 变化时触发 0.3 秒线性过渡 */
    '  transition: transform 0.3s linear, opacity 0.3s linear, visibility 0s linear 0.3s;',
    '}',

    /* 显示状态：可见 + 不透明 + 回到原始位置 */
    '.cp-float-panel--visible {',
    '  visibility: visible;',
    '  opacity: 1;',
    '  transform: translateX(0);',
    /* 显示时 visibility 立即切换（无延迟），让 transition 立即生效 */
    '  transition: transform 0.3s linear, opacity 0.3s linear, visibility 0s linear 0s;',
    '}',

    /* 头部 */
    '.cp-header { display: flex; align-items: center; gap: 6px; }',
    '.cp-logo { width: 22px; height: 22px; }',
    '.cp-title { font-size: 13px; font-weight: 500; color: #333; flex: 1; }',

    '.cp-github {',
    '  color: #999; display: flex; align-items: center;',
    '  text-decoration: none; transition: color 0.15s ease;',
    '  margin-right: 10px;',
    '}',
    '.cp-github:hover { color: #333; }',
    '.cp-github-icon { display: block; }',

    '.cp-close-btn {',
    '  width: 22px; height: 22px; border: none; background: transparent;',
    '  color: #999; font-size: 22px; line-height: 1; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  border-radius: 4px; transition: all 0.15s ease;',
    '}',
    '.cp-close-btn:hover { background: #f0f0f0; color: #333; }',

    /* 卡片 */
    '.cp-card { background: #e8e8eb; border-radius: 4px; padding: 4px; }',
    '.cp-card--info { display: flex; flex-direction: row; gap: 4px; align-items: stretch; }',
    '.cp-card-content { display: flex; flex-direction: column; gap: 4px; }',
    '.cp-card-content--narrow { width: 75%; }',

    /* 预览 */
    '.cp-preview {',
    '  flex: 1; min-width: 0; overflow: hidden;',
    '  background: #ffffff; border: 1px solid #DCDFE6;',
    '  border-radius: 4px; display: flex; align-items: center; justify-content: center;',
    '}',
    '.cp-preview-text { color: #777; font-size: 14px; text-align: center; }',

    /* 按钮 */
    '.cp-btn {',
    '  display: flex; align-items: center; width: 100%;',
    '  padding: 7px 10px; font-size: 13px; color: #777;',
    '  font-weight: 500; background: #ffffff;',
    '  border: 1px solid #DCDFE6; border-radius: 4px;',
    '  cursor: copy; transition: all 0.15s ease; text-align: left; font-family: inherit;',
    '}',
    '.cp-btn:hover { background: #f1f1f1; border-color: #c0c4cc; }',
    '.cp-btn:active { transform: scale(0.98); }',

    '.cp-btn--save {',
    '  cursor: pointer; color: #888; font-size: 12px;',
    '  padding: 5px 10px; justify-content: center;',
    '}',
    '.cp-btn--save:hover { color: #e67e22; background: #fdf2e9; border-color: #e67e22; }',
    '.cp-btn--save.cp-btn--saved { color: #fff; background: #e67e22; border-color: #e67e22; }',
    '.cp-btn--save.cp-btn--saved:hover { background: #d35400; border-color: #d35400; }',
    '.cp-btn--save:disabled { opacity: 0.5; cursor: not-allowed; }',

    /* 标题 */
    '.cp-title-text { font-weight: 400; user-select: none; }',

    /* 分页 */
    '.cp-pagination { display: flex; align-items: center; gap: 6px; }',

    '.cp-page-btn {',
    '  width: 24px; height: 24px; border: 1px solid #DCDFE6;',
    '  background: #ffffff; border-radius: 4px;',
    '  cursor: pointer; font-size: 16px; color: #555;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: all 0.15s ease;',
    '}',
    '.cp-page-btn:hover:not(:disabled) { background: #f1f1f1; border-color: #c0c4cc; }',
    '.cp-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }',

    '.cp-history-list {',
    '  list-style: none; display: flex; gap: 6px;',
    '  flex: 1; justify-content: flex-start;',
    '}',
    '.cp-history-item {',
    '  width: 28px; height: 28px; border-radius: 50%;',
    '  border: 2px solid #DCDFE6; cursor: pointer;',
    '  transition: all 0.15s ease;',
    '}',
    '.cp-history-item:hover { transform: scale(1.15); border-color: #999; }',

    /* 收藏夹 */
    '.cp-fav-header { display: flex; align-items: center; gap: 6px; }',
    '.cp-fav-count { font-size: 12px; color: #999; }',
    '.cp-fav-clear {',
    '  margin-left: auto; border: 2px solid #DCDFE6; background: transparent;',
    '  color: #999; font-size: 12px; cursor: pointer; padding: 2px 6px;',
    '  border-radius: 3px; transition: all 0.15s ease;',
    '}',
    '.cp-fav-clear:hover { background: #f0f0f0; color: #e74c3c; border-color: #e74c3c; }',

    '.cp-fav-list {',
    '  display: flex; flex-wrap: wrap; gap: 6px;',
    '  min-height: 32px; align-items: center;',
    '}',
    '.cp-fav-item {',
    '  width: 32px; height: 32px; border-radius: 6px;',
    '  border: 2px solid #DCDFE6; cursor: pointer;',
    '  position: relative; transition: all 0.15s ease;',
    '}',
    '.cp-fav-item:hover { transform: scale(1.1); border-color: #999; }',
    '.cp-fav-item:hover .cp-fav-delete { opacity: 1; }',

    '.cp-fav-delete {',
    '  position: absolute; top: -7px; right: -7px;',
    '  width: 18px; height: 18px; border-radius: 50%;',
    '  border: none; background: #e74c3c; color: #fff;',
    '  font-size: 12px; line-height: 1; cursor: pointer;',
    '  opacity: 0; transition: opacity 0.15s ease;',
    '  display: flex; align-items: center; justify-content: center;',
    '}',
    '.cp-fav-delete:hover { background: #c0392b; }',

    '.cp-hint { color: #999; font-size: 13px; text-align: center; width: 100%; padding: 8px 0; }',

    /* 底部 */
    '.cp-footer { display: flex; justify-content: center; }',

    '.cp-pick-btn {',
    '  width: 100%; padding: 8px 20px;',
    '  font-size: 24px; font-weight: 600;',
    '  color: #fff; background: #4A90D9;',
    '  border: none; border-radius: 6px;',
    '  cursor: pointer; transition: all 0.15s ease;',
    '  font-family: inherit;',
    '}',
    '.cp-pick-btn:hover { background: #357ABD; }',
    '.cp-pick-btn:active { transform: scale(0.98); }',
    '.cp-pick-btn:disabled { opacity: 0.6; cursor: not-allowed; }',

    /* 滚动条 */
    '.cp-float-panel::-webkit-scrollbar { width: 4px; }',
    '.cp-float-panel::-webkit-scrollbar-track { background: transparent; }',
    '.cp-float-panel::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }',
    '.cp-float-panel::-webkit-scrollbar-thumb:hover { background: #aaa; }',
  ].join('\n');
}
