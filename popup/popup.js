// ============================================================
// popup.js —— 弹窗页面脚本（主控制逻辑）
//
// 本文件是扩展的核心交互脚本，负责以下功能：
//   1. 颜色格式转换：HEX / RGB / HSL / HSV 互转
//   2. 取色流程控制：调用 chrome.tabs.captureVisibleTab 截图，
//      将截图数据发送给 content script 进行页面取色
//   3. 颜色历史管理：持久化存储最近 10 条取色记录到 chrome.storage
//   4. 收藏夹管理：持久化存储最多 12 个收藏颜色到 chrome.storage
//
// 数据流（取色流程）：
//   用户点击 Pick → popup 截图 → 发送消息给 content script
//   → popup 关闭 → content script 显示放大镜 → 用户点击取色
//   → content script 保存 { pickedColor, pickedColorNew: true } 到 storage
//   → 用户再次打开 popup → 读取 storage → 显示颜色 + 自动复制 + 添加历史
//
// 消息协议（与 content script 通信）：
//   popup → content: { type: "START_PICKER", dataUrl: "data:image/png;..." }
// ============================================================

// ========== 常量配置 ==========
const PAGE_SIZE = 5;       // 历史记录每页显示数量（每个圆形色块 28px + 6px 间距）
const MAX_HISTORY = 10;    // 历史记录最大条数，超出后自动淘汰最早的记录
const MAX_FAVORITES = 12;  // 收藏夹最大容量，达到上限后收藏按钮禁用

// ========== DOM 元素引用 ==========
// 颜色显示相关
const colorPreview = document.getElementById('colorPreview');  // 颜色预览区域
const btnHex = document.getElementById('btnHex');              // HEX 格式按钮（点击复制）
const btnRgb = document.getElementById('btnRgb');              // RGB 格式按钮（点击复制）
const btnHsl = document.getElementById('btnHsl');              // HSL 格式按钮（点击复制）
const btnHsv = document.getElementById('btnHsv');              // HSV 格式按钮（点击复制）

// 操作按钮
const btnPick = document.getElementById("btnPick");            // 主取色按钮

// 历史记录相关
const btnPageLeft = document.getElementById('btnPageLeft');    // 上一页按钮
const btnPageRight = document.getElementById('btnPageRight');  // 下一页按钮
const historyList = document.getElementById('historyList');    // 历史记录列表容器
const btnClearHistory = document.getElementById('btnClearHistory'); // 清空历史按钮

// 收藏夹相关
const btnSave = document.getElementById('btnSave');            // 收藏按钮（颜色信息卡片内）
const favoriteList = document.getElementById('favoriteList');  // 收藏颜色列表容器
const favoriteCount = document.getElementById('favoriteCount');// 收藏数量计数器（如 "3/10"）
const btnClearFavorites = document.getElementById('btnClearFavorites'); // 清空收藏按钮

// ========== 全局状态 ==========
let currentPage = 0;       // 当前历史记录页码（从 0 开始）
let colorHistory = [];      // 颜色历史记录数组（最新在前），持久化到 chrome.storage.local
let savedColors = [];       // 收藏颜色数组（HEX 格式字符串），持久化到 chrome.storage.local
// 当前选中颜色的完整信息对象，用于显示和复制
// 结构示例: { hex: "#FF6B6B", rgb: {r:255,g:107,b:107}, hsl: {h:0,s:100,l:71}, hsv: {...} }
let colors = { hex: '', rgb: '', hsl: '', hsv: '' };

// ========== 颜色转换工具函数 ==========
// 以下函数实现了四种颜色格式之间的转换链：
//   HEX ←→ RGB ←→ HSL
//   HEX ←→ RGB ←→ HSV

/**
 * HEX 颜色字符串 → RGB 对象
 * @param {string} hex - HEX 颜色值，如 "#FF6B6B"
 * @returns {{ r: number, g: number, b: number }} - RGB 各分量 (0-255)
 * 实现原理：将 HEX 字符串转为整数，然后通过位运算分别提取 R/G/B 三个通道
 */
function hexToRgb(hex) {
    const num = parseInt(hex.slice(1), 16);  // 去掉 "#" 后将十六进制转为十进制整数
    return {
        r: (num >> 16) & 255,   // 右移 16 位取红色通道（高 8 位）
        g: (num >> 8) & 255,    // 右移 8 位取绿色通道（中间 8 位）
        b: num & 255,           // 不移位直接取蓝色通道（低 8 位）
    };
}

/**
 * RGB 对象 → HSL 对象
 * HSL (Hue-Saturation-Lightness) 是一种更直观的颜色表示方式
 * @param {{ r: number, g: number, b: number }} rgb - RGB 各分量 (0-255)
 * @returns {{ h: number, s: number, l: number }} - HSL 值，h:0-360, s/l:0-100
 */
function rgbToHsl({ r, g, b }) {
    // 先将 RGB 从 [0,255] 归一化到 [0,1]
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;  // 亮度 = 最大值和最小值的平均值

    // 如果最大值等于最小值，说明是灰度色（无饱和度，色相无意义）
    if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };

    const d = max - min;  // 色差范围
    // 饱和度计算：亮度 > 0.5 时用不同于 < 0.5 的公式，避免饱和度溢出
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    // 色相计算：根据哪个通道是最大值来选择不同的计算公式
    let h;
    switch (max) {
        case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break; // 红色最大
        case gn: h = ((bn - rn) / d + 2) / 6; break;                 // 绿色最大
        default:  h = ((rn - gn) / d + 4) / 6; break;                 // 蓝色最大
    }

    return {
        h: Math.round(h * 360),   // 色相：0°(红) → 60°(黄) → 120°(绿) → 180°(青) → 240°(蓝) → 300°(品红)
        s: Math.round(s * 100),   // 饱和度：0%(灰) → 100%(纯色)
        l: Math.round(l * 100),   // 亮度：0%(黑) → 50%(正常) → 100%(白)
    };
}

/**
 * RGB 对象 → HSV 对象
 * HSV (Hue-Saturation-Value) 是另一种直观的颜色模型，常用于颜色选择器
 * 与 HSL 的区别：V(明度)衡量的是纯色的亮度，而 L(亮度)同时考虑了黑和白的混合
 * @param {{ r: number, g: number, b: number }} rgb - RGB 各分量 (0-255)
 * @returns {{ h: number, s: number, v: number }} - HSV 值，h:0-360, s/v:0-100
 */
function rgbToHsv({ r, g, b }) {
    // 先将 RGB 从 [0,255] 归一化到 [0,1]
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const v = max;  // 明度就是 RGB 中的最大值

    // 灰度色处理
    if (max === min) return { h: 0, s: 0, v: Math.round(v * 100) };

    const d = max - min;
    const s = d / max;  // 饱和度 = 色差 / 最大值

    // 色相计算（与 HSL 完全相同的算法）
    let h;
    switch (max) {
        case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
        case gn: h = ((bn - rn) / d + 2) / 6; break;
        default:  h = ((rn - gn) / d + 4) / 6; break;
    }

    return {
        h: Math.round(h * 360),   // 色相（与 HSL 相同）
        s: Math.round(s * 100),   // 饱和度：0%(灰) → 100%(纯色)
        v: Math.round(v * 100),   // 明度：0%(黑) → 100%(最亮)
    };
}

// ========== UI 更新 ==========

/**
 * 更新颜色信息显示（HEX/RGB/HSL/HSV 按钮文本 + 颜色预览块）
 * 此函数是颜色显示的核心，所有颜色变更最终都通过此函数更新界面
 * @param {string} hex - HEX 颜色值，如 "#FF6B6B"
 * @param {boolean} addToHistory - 是否同时添加到历史记录
 *   true: 新取色的颜色，需要记录到历史
 *   false: 从历史/收藏中点击的颜色，不需要重复记录
 */
function updateColorInfo(hex, addToHistory = true) {
    // 通过 HEX → RGB → HSL/HSV 的转换链获取所有格式的颜色值
    const rgb = hexToRgb(hex);
    const hsl = rgbToHsl(rgb);
    const hsv = rgbToHsv(rgb);

    // 更新全局颜色对象，供复制功能使用
    // 语法糖: 属性简写(Shorthand Properties): 当对象的键名和变量名相同时，可以只写一次。
    colors = { hex, rgb, hsl, hsv };

    // 更新四个格式按钮的显示文本
    btnHex.textContent = `HEX: ${hex}`;
    btnRgb.textContent = `RGB: ${rgb.r}, ${rgb.g}, ${rgb.b}`;
    btnHsl.textContent = `HSL: ${hsl.h}, ${hsl.s}%, ${hsl.l}%`;
    btnHsv.textContent = `HSV: ${hsv.h}, ${hsv.s}%, ${hsv.v}%`;

    // 更新颜色预览块背景色
    colorPreview.style.backgroundColor = hex;
    // 隐藏 "Preview" 占位文字（首次取色后不再显示）
    colorPreview.querySelector('.card__preview-text').style.display = 'none';

    // 根据参数决定是否将颜色添加到历史记录
    if (addToHistory) {
        addHistoryColor(hex);
    }

    // 根据收藏夹状态更新收藏按钮外观（空心/实心星形）
    updateSaveBtnState();
}

// ========== 剪贴板复制 ==========

/**
 * 剪贴板写入的兜底方案
 * 在 navigator.clipboard.writeText 不可用（如缺少用户手势上下文）时，
 * 使用 execCommand('copy') 实现复制
 */
function fallbackCopyToClipboard(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } catch (e) {
        // 静默失败
    }
    document.body.removeChild(textarea);
}

/**
 * 复制指定格式的颜色值到系统剪贴板
 * @param {string} colorCode - 颜色格式类型: 'hex' | 'rgb' | 'hsl' | 'hsv'
 * @param {boolean} showFeedback - 是否在 Pick 按钮上显示 "Copied!" 视觉反馈
 *   用户手动点击复制按钮时显示反馈；popup 初始化时自动复制不显示（避免每次打开都闪）
 */
function copyColorToClipboard(colorCode, showFeedback = true) {
    // 如果尚未取色（全局颜色对象为空），直接返回
    if (!colors.hex) {
        return;
    }

    // 根据格式类型组装要复制的纯文本字符串
    let text = '';
    if (colorCode === 'hex') {
        text = colors.hex;  // 例: "#FF6B6B"
    } else if (colorCode === 'rgb') {
        text = `${colors.rgb.r}, ${colors.rgb.g}, ${colors.rgb.b}`;  // 例: "255, 107, 107"
    } else if (colorCode === 'hsl') {
        text = `${colors.hsl.h}, ${colors.hsl.s}%, ${colors.hsl.l}%`;  // 例: "0, 100%, 71%"
    } else if (colorCode === 'hsv') {
        text = `${colors.hsv.h}, ${colors.hsv.s}%, ${colors.hsv.v}%`;  // 例: "0, 58%, 100%"
    }

    // 优先使用 Clipboard API，失败时使用 execCommand 兜底
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }

    // 在 Pick 按钮上显示 "Copied!" 反馈文字，1秒后恢复
    if (showFeedback) {
        btnPick.textContent = 'Copied!';
        setTimeout(() => {
            btnPick.textContent = 'Pick';
        }, 1000);
    }
}

// ========== 取色逻辑（截图 + 内容脚本方式） ==========
// 取色流程说明：
//   旧方式（已移除）：使用 EyeDropper API，仅 Chrome 95+ 支持，且无法显示放大镜
//   新方式（当前）：使用 chrome.tabs.captureVisibleTab 截取标签页截图，
//     将截图通过消息发送给 content script，由 content script 在页面上
//     创建放大镜遮罩层，用户通过放大镜精确定位像素后点击取色。
//   优势：兼容性更好，支持放大镜预览，不依赖 EyeDropper API。

/**
 * 启动取色流程
 * 步骤：
 *   1. 禁用 Pick 按钮并显示 "截图中..." 状态
 *   2. 获取当前活动标签页
 *   3. 调用 captureVisibleTab 截取可见区域截图
 *   4. 将截图发送给 content script
 *   5. content script 确认接收后关闭 popup（让用户在页面上操作）
 */
function pickColor() {
    // 设置按钮为加载状态，防止用户重复点击
    btnPick.disabled = true;
    btnPick.textContent = 'Capturing...';

    // 获取当前窗口的活动标签页
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const tab = tabs[0];
        if (!tab) {
            resetPickBtn();
            return;
        }

        // 截取当前可见标签页的屏幕截图（返回 base64 编码的 PNG data URL）
        chrome.tabs.captureVisibleTab(null, { format: "png" }, function (dataUrl) {
            if (chrome.runtime.lastError || !dataUrl) {
                console.error("[Pick] 截图失败:", chrome.runtime.lastError);
                resetPickBtn();
                return;
            }

            // 将截图数据和取色指令发送给 content script
            sendPickerMessage(tab.id, dataUrl, 0);
        });
    });
}

/**
 * 向 content script 发送 START_PICKER 消息
 * 包含容错机制：首次发送失败时，尝试通过 chrome.scripting.executeScript
 * 动态注入 content script 到目标页面（处理 manifest 未自动匹配的页面，如新标签页等）
 *
 * @param {number} tabId - 目标标签页 ID
 * @param {string} dataUrl - 截图的 base64 data URL
 * @param {number} retryCount - 当前重试次数（最多重试 1 次）
 */
function sendPickerMessage(tabId, dataUrl, retryCount) {
    chrome.tabs.sendMessage(tabId, {
        type: "START_PICKER",   // 消息类型：启动取色器
        dataUrl: dataUrl,       // 页面截图数据
    }, function (response) {
        if (chrome.runtime.lastError) {
            if (retryCount === 0) {
                // 首次发送失败 → 尝试动态注入 content script
                // 适用场景：manifest 的 content_scripts 未自动匹配的页面
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ["content-scripts/content.js"],
                }, function () {
                    if (chrome.runtime.lastError) {
                        console.error("[Pick] 注入失败:", chrome.runtime.lastError);
                        resetPickBtn();
                        return;
                    }
                    // 注入成功，递归重试发送消息（retryCount = 1）
                    sendPickerMessage(tabId, dataUrl, 1);
                });
                return;
            }
            // 重试仍然失败，放弃取色
            console.error("[Pick] 启动失败");
            resetPickBtn();
            return;
        }
        // 消息发送成功 → 关闭 popup，让用户在页面上使用放大镜取色
        window.close();
    });
}

/** 重置 Pick 按钮到默认可点击状态 */
function resetPickBtn() {
    btnPick.disabled = false;
    btnPick.textContent = 'Pick';
}

// ========== 历史记录管理（持久化到 chrome.storage） ==========
// 历史记录采用 "最新在前" 的数组结构，最多保留 MAX_HISTORY 条
// 数据持久化到 chrome.storage.local，popup 关闭重开后数据不丢失

/**
 * 渲染当前页的历史记录颜色列表
 * 根据 currentPage 和 PAGE_SIZE 计算当前页的数据范围，
 * 为每个颜色创建圆形色块 DOM 元素
 */
function renderHistoryPage() {
    historyList.innerHTML = '';  // 清空现有列表

    // 计算当前页的起始索引和对应的数据切片
    const start = currentPage * PAGE_SIZE;
    const pageItems = colorHistory.slice(start, start + PAGE_SIZE);

    // 为当前页的每个颜色创建圆形色块
    pageItems.forEach(hex => {
        const li = document.createElement('li');
        li.className = 'card__list-item';  // BEM: card 块的 list-item 元素
        li.title = hex;                     // 鼠标悬停时显示完整 HEX 值
        li.style.backgroundColor = hex;     // 用颜色本身作为背景色
        // 点击历史色块 → 更新颜色显示（addToHistory = false，避免重复记录）
        li.addEventListener('click', () => updateColorInfo(hex, false));
        historyList.appendChild(li);
    });

    // 根据当前页码更新分页按钮的禁用状态
    const totalPages = Math.ceil(colorHistory.length / PAGE_SIZE);
    btnPageLeft.disabled = currentPage <= 0;                    // 第一页时禁用"上一页"
    btnPageRight.disabled = currentPage >= totalPages - 1;       // 最后一页时禁用"下一页"
}

/**
 * 添加颜色到历史记录（头部插入）
 * 包含去重逻辑：如果新颜色与历史中最近的一条相同，则不重复添加
 * 超过 MAX_HISTORY 时自动移除最旧的一条
 * 每次修改后自动同步到 chrome.storage.local
 *
 * @param {string} hex - 要添加的 HEX 颜色值
 */
function addHistoryColor(hex) {
    // 去重：与数组第一个元素（最近一条记录）相同时不重复添加
    // 场景：popup 重新打开时读取到的 pickedColor 可能与历史首条相同
    if (colorHistory.length > 0 && colorHistory[0] === hex) return;

    // 新记录插入数组头部（最新在前）
    colorHistory.unshift(hex);

    // 超出上限时移除数组末尾最旧的记录
    if (colorHistory.length > MAX_HISTORY) {
        colorHistory.pop();
    }

    // 添加新记录后重置到第一页
    currentPage = 0;
    renderHistoryPage();

    // 持久化历史记录到 chrome.storage.local
    chrome.storage.local.set({ colorHistory: colorHistory });
}

// ========== 收藏夹管理（持久化到 chrome.storage） ==========
// 收藏夹允许用户主动保存喜欢的颜色，与自动记录的历史不同
// 最多保存 MAX_FAVORITES 个颜色，用户可以手动删除或清空

/**
 * 渲染收藏颜色列表
 * 遍历 savedColors 数组，为每个颜色创建一个带删除按钮的色块
 * 空状态时显示 "暂无收藏" 提示文字
 */
function renderFavorites() {
    favoriteList.innerHTML = '';  // 清空现有列表

    if (savedColors.length === 0) {
        // 空状态：显示提示文字
        const hint = document.createElement('p');
        hint.className = 'card__hint';       // BEM: card 块的 hint 元素
        hint.textContent = 'No favorites';
        favoriteList.appendChild(hint);
    } else {
        // 为每个收藏颜色创建色块
        savedColors.forEach((color, index) => {
            // --- 收藏颜色项容器 ---
            const item = document.createElement('div');
            item.className = 'card__fav-item';  // BEM: card 块的 fav-item 元素（圆角方形）
            item.style.backgroundColor = color;
            item.title = color;  // 鼠标悬停显示 HEX 值

            // 点击收藏项 → 更新颜色显示面板
            // 注意：排除点击删除按钮的情况（通过事件委托判断）
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('card__fav-delete')) return;
                updateColorInfo(color, false);  // 不添加到历史（从收藏点的不算新取色）
            });

            // --- 删除按钮（默认隐藏，悬停收藏项时显示） ---
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'card__fav-delete';  // BEM: card 块的 fav-delete 元素
            deleteBtn.textContent = '\u00d7';           // × 字符（乘号）
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();  // 阻止冒泡，避免触发父元素的 click 事件
                savedColors.splice(index, 1);  // 从数组中移除该项
                renderFavorites();  // 重新渲染列表
                updateSaveBtnState(); // 同步更新收藏按钮状态
                chrome.storage.local.set({ savedColors: savedColors });  // 同步到 storage
            });

            item.appendChild(deleteBtn);
            favoriteList.appendChild(item);
        });
    }

    // 更新收藏计数器显示（如 "3/10"）
    updateFavoriteCount();
}

/**
 * 添加当前颜色到收藏夹
 * 如果已达到 MAX_FAVORITES 上限，则不执行添加
 *
 * @param {string} hex - 要收藏的 HEX 颜色值
 */
function addFavorite(hex) {
    // 达到收藏上限时不添加
    if (savedColors.length >= MAX_FAVORITES) return;
    savedColors.unshift(hex);     // 插入到数组头部（最新在前）
    renderFavorites();         // 重新渲染列表
    // 持久化收藏颜色到 chrome.storage.local
    chrome.storage.local.set({ savedColors: savedColors });
}

/**
 * 更新收藏按钮的视觉状态（空心星形 / 实心星形）
 * 根据当前颜色是否已在收藏夹中动态切换按钮外观
 */
function updateSaveBtnState() {
    if (!colors.hex) return;
    const isSaved = savedColors.includes(colors.hex);
    if (isSaved) {
        btnSave.innerHTML = '&#9733; Favorited';   // ★ 实心星形 + "Favorited"
        btnSave.classList.add('card__btn--saved');   // 添加已收藏样式（橙色填充）
        btnSave.title = 'Remove from favorites';
    } else {
        btnSave.innerHTML = '&#9734; Favorite';     // ☆ 空心星形 + "Favorite"
        btnSave.classList.remove('card__btn--saved'); // 移除已收藏样式
        btnSave.title = 'Add to favorites';
    }
    // 达到上限且未收藏时禁用按钮
    btnSave.disabled = !isSaved && savedColors.length >= MAX_FAVORITES;
}

/** 更新收藏夹计数器的文本显示（如 "3/12"） */
function updateFavoriteCount() {
    favoriteCount.textContent = `${savedColors.length}/${MAX_FAVORITES}`;
}

// ========== 事件绑定 ==========

// --- 取色按钮：启动截图取色流程 ---
btnPick.addEventListener("click", pickColor);

// --- 格式复制按钮：点击后将对应格式的颜色值写入剪贴板 ---
btnHex.addEventListener("click", () => copyColorToClipboard('hex'));
btnRgb.addEventListener("click", () => copyColorToClipboard('rgb'));
btnHsl.addEventListener("click", () => copyColorToClipboard('hsl'));
btnHsv.addEventListener("click", () => copyColorToClipboard('hsv'));

// --- 收藏按钮：将当前颜色添加到收藏夹 ---
// --- 收藏按钮：切换收藏状态（添加/移除） ---
btnSave.addEventListener("click", () => {
    if (!colors.hex || btnSave.disabled) return;   // 尚未取色或已禁用时不执行

    const index = savedColors.indexOf(colors.hex);
    if (index !== -1) {
        // 已收藏 → 取消收藏
        savedColors.splice(index, 1);
    } else {
        // 未收藏 → 添加收藏（头部插入，最新在前）
        if (savedColors.length >= MAX_FAVORITES) return;
        savedColors.unshift(colors.hex);
    }

    renderFavorites();    // 重新渲染收藏列表
    updateSaveBtnState(); // 更新按钮状态（星形切换）
    chrome.storage.local.set({ savedColors: savedColors }); // 持久化到 storage
});

// --- 清空收藏按钮：一键清空所有收藏颜色 ---
btnClearFavorites.addEventListener("click", () => {
    savedColors = [];                          // 清空内存数组
    renderFavorites();                          // 重新渲染列表（显示空状态提示）
    chrome.storage.local.set({ savedColors: [] }); // 同步到 storage
    updateSaveBtnState();                       // 更新收藏按钮状态
});

/** 重置颜色预览到初始状态（无取色时的默认外观） */
function resetColorPreview() {
    // 重置全局颜色对象
    colors = { hex: '', rgb: '', hsl: '', hsv: '' };

    // 重置格式按钮文本为默认值
    btnHex.textContent = 'HEX: ';
    btnRgb.textContent = 'RGB: ';
    btnHsl.textContent = 'HSL: ';
    btnHsv.textContent = 'HSV: ';

    // 还原颜色预览块：白色背景 + 显示 "Preview" 文字
    colorPreview.style.backgroundColor = '#ffffff';
    colorPreview.querySelector('.card__preview-text').style.display = '';

    // 重置收藏按钮状态
    btnSave.innerHTML = '&#9734; Favorite';
    btnSave.classList.remove('card__btn--saved');
    btnSave.disabled = false;
    btnSave.title = 'Add to favorites';
}

// --- 清空历史按钮：一键清空所有历史颜色 ---
btnClearHistory.addEventListener("click", () => {
    colorHistory = [];                          // 清空内存数组
    currentPage = 0;                            // 重置到第一页
    renderHistoryPage();                        // 重新渲染列表
    chrome.storage.local.set({ colorHistory: [], pickedColor: '', pickedColorNew: false }); // 同步到 storage
    resetColorPreview();                        // 还原颜色预览到初始状态
});

// --- 历史记录分页按钮 ---
// 上一页：页码减 1（最小为 0）
btnPageLeft.addEventListener('click', () => {
    if (currentPage > 0) {
        currentPage--;
        renderHistoryPage();
    }
});

// 下一页：页码加 1（最大为总页数 - 1）
btnPageRight.addEventListener('click', () => {
    const totalPages = Math.ceil(colorHistory.length / PAGE_SIZE);
    if (currentPage < totalPages - 1) {
        currentPage++;
        renderHistoryPage();
    }
});

// ========== 页面初始化 ==========
// popup 每次打开时执行此初始化逻辑：
//   1. 检查 URL 参数中是否有取色结果（由 background 窗口创建时传入）
//   2. 从 chrome.storage.local 加载持久化数据（收藏夹、历史、取色结果）
//   3. 根据数据状态决定显示什么内容

document.addEventListener("DOMContentLoaded", function () {
    // ★ 优先检查 URL 参数中是否有取色结果
    // 当 background 收到 PICKER_COMPLETE 消息后，通过 chrome.windows.create
    // 打开 popup.html?result=#RRGGBB，这里直接解析并显示该颜色
    const urlParams = new URLSearchParams(window.location.search);
    const resultColor = urlParams.get('result');

    if (resultColor) {
        // 情况 0：通过 URL 参数直接获取颜色（取色完成后自动弹出的窗口）
        // 先加载收藏夹和历史记录
        chrome.storage.local.get(["colorHistory", "savedColors"], function (result) {
            savedColors = result.savedColors || [];
            renderFavorites();

            colorHistory = result.colorHistory || [];
            renderHistoryPage();

            // 显示取色结果，添加到历史记录
            updateColorInfo(resultColor, true);
            // 自动复制 HEX 到剪贴板
            copyColorToClipboard('hex', true);
            // 清除 storage 中的新取色标记（如果有的话）
            chrome.storage.local.set({ pickedColorNew: false });
        });
        return; // 跳过后续 storage 读取逻辑
    }

    // 从 storage 一次性读取所有需要的数据
    chrome.storage.local.get(["pickedColor", "pickedColorNew", "colorHistory", "savedColors"], function (result) {
        // ---- 加载收藏夹 ----
        savedColors = result.savedColors || [];
        renderFavorites();

        // ---- 加载历史记录 ----
        colorHistory = result.colorHistory || [];
        renderHistoryPage();

        // ---- 处理取色结果（按优先级判断显示逻辑） ----
        if (result.pickedColorNew && result.pickedColor) {
            // 情况 A：本次新取色（用户刚完成一次取色操作）
            //   pickedColorNew 为 content script 取色成功时设置的标记
            //   操作：更新显示、添加历史、自动复制 HEX 到剪贴板
            updateColorInfo(result.pickedColor, true);
            copyColorToClipboard('hex', true);
            // 清除新取色标记，避免下次打开 popup 时重复处理
            chrome.storage.local.set({ pickedColorNew: false });
        } else if (result.pickedColor) {
            // 情况 B：有历史取色结果但不是本次新取色（如 popup 重新打开）
            //   操作：仅显示颜色，不添加历史，不自动复制
            updateColorInfo(result.pickedColor, false);
        } else if (colorHistory.length > 0) {
            // 情况 C：没有取色结果，但有历史记录
            //   操作：显示最近一条历史颜色作为默认展示
            updateColorInfo(colorHistory[0], false);
        } else {
            // 情况 D：完全无数据（首次安装使用）
            //   操作：保持初始空白状态
            resetColorPreview();
        }
    });
});
