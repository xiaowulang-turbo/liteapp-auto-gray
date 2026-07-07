// ==UserScript==
// @name         Liteapp 灰度自动上线
// @namespace    https://lite.weixin.woa.com/
// @version      1.3.0
// @description  自动检测并点击"灰度上线"按钮，弹窗中自动确认。使用 helper tab + Web Worker 多重保活机制对抗后台 tab 节流
// @author       xiaowuruan
// @match        https://lite.weixin.woa.com/console/*/release/change/info/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 常量 ====================

  const POLL_INTERVAL = 3000;            // 前台轮询间隔：3 秒
  const DIALOG_POLL_INTERVAL = 500;      // 弹窗轮询：0.5 秒
  const HEARTBEAT_INTERVAL = 1000;       // Worker 心跳：1 秒
  const HELPER_TAB_INTERVAL = 5000;      // Helper tab 心跳：5 秒

  // ==================== 状态 ====================

  let pollTimer = null;
  let dialogTimer = null;
  let lastClickTime = null;
  let isConfirming = false;
  let worker = null;
  let helperTab = null;
  let helperTabReady = false;
  let broadcastChannel = null;

  // ==================== 灰度上线按钮相关 ====================

  function findGrayButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (text.includes('灰度上线')) {
        return btn;
      }
    }
    return null;
  }

  function isButtonEnabled(btn) {
    return !btn.disabled && !btn.classList.contains('t-is-disabled');
  }

  function extractCountdown(btn) {
    const match = btn.textContent.match(/\((\d+)秒\)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // ==================== 弹窗确认相关 ====================

  function findDialogConfirmButton() {
    const dialogs = document.querySelectorAll('.t-dialog__ctx');
    for (const dialog of dialogs) {
      const style = window.getComputedStyle(dialog);
      if (style.display === 'none') continue;

      const title = dialog.querySelector('.t-dialog__header-content');
      if (!title || !title.textContent.includes('灰度上线')) continue;

      const buttons = dialog.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '确定' && !btn.disabled) {
          return btn;
        }
      }
    }
    return null;
  }

  function clickDialogConfirm(btn) {
    console.log('[灰度自动上线] ✅ 点击弹窗确认按钮...');
    btn.click();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    isConfirming = false;
    console.log('[灰度自动上线] ✅ 弹窗已确认，等待下一轮灰度...');
  }

  function startDialogPolling() {
    if (dialogTimer) return;
    isConfirming = true;

    console.log('[灰度自动上线] 🔍 开始检测确认弹窗...');
    dialogTimer = setInterval(() => {
      const confirmBtn = findDialogConfirmButton();
      if (confirmBtn) {
        clickDialogConfirm(confirmBtn);
        stopDialogPolling();
      }
    }, DIALOG_POLL_INTERVAL);

    setTimeout(() => {
      if (dialogTimer) {
        console.log('[灰度自动上线] ⚠️ 弹窗检测超时');
        stopDialogPolling();
        isConfirming = false;
      }
    }, 10000);
  }

  function stopDialogPolling() {
    if (dialogTimer) {
      clearInterval(dialogTimer);
      dialogTimer = null;
    }
  }

  // ==================== 主逻辑 ====================

  function clickGrayButton(btn) {
    console.log('[灰度自动上线] 🚀 点击灰度上线按钮...');
    lastClickTime = new Date();

    btn.disabled = false;
    btn.classList.remove('t-is-disabled');
    btn.click();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    startDialogPolling();
  }

  function checkAndClick(source) {
    if (isConfirming) return;

    const btn = findGrayButton();
    if (!btn) {
      // 按钮消失不代表完成，可能只是被切到告警 tab 了
      return;
    }

    if (isButtonEnabled(btn)) {
      // 防止短时间内重复点击
      if (lastClickTime && (Date.now() - lastClickTime.getTime()) < 30000) {
        return;
      }
      console.log(`[灰度自动上线] 🎯 检测到可点击按钮 (来源: ${source})`);
      clickGrayButton(btn);
    }
  }

  // ==================== Helper Tab 策略 ====================

  /**
   * 创建一个隐藏的 helper tab，让 Chrome 不会将主 tab 视为"完全后台"
   * 多个 tab 轮换前台是 Chrome 自身的机制
   */
  function setupHelperTab() {
    // 使用 BroadcastChannel 在主 tab 和 helper tab 之间通信
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel('liteapp-gray-helper');
      broadcastChannel.onmessage = (e) => {
        if (e.data.type === 'helper-ready') {
          helperTabReady = true;
          console.log('[灰度自动上线] 🛰️  Helper tab 已就绪');
        } else if (e.data.type === 'heartbeat-from-helper') {
          // Helper tab 5 秒一次心跳，收到时立即检查
          checkAndClick('helper-tab');
        } else if (e.data.type === 'check-now') {
          checkAndClick('helper-tab-request');
        }
      };
    }

    // 尝试打开一个隐藏的 helper tab（小窗口，Chrome 会优先调度它）
    try {
      const helperUrl = window.location.origin + window.location.pathname + '?_helper=1#' + Date.now();
      helperTab = window.open('about:blank', 'liteapp-gray-helper-window', 'width=1,height=1,left=-9999,top=-9999');
      if (helperTab) {
        // 写入 helper 脚本
        helperTab.document.write(`
          <!DOCTYPE html>
          <html>
          <head><title>灰度辅助</title></head>
          <body>
            <script>
              (function() {
                const channel = new BroadcastChannel('liteapp-gray-helper');
                channel.postMessage({ type: 'helper-ready' });

                // 每 ${HELPER_TAB_INTERVAL / 1000} 秒向主 tab 发心跳
                setInterval(() => {
                  channel.postMessage({ type: 'heartbeat-from-helper' });
                }, ${HELPER_TAB_INTERVAL});

                // 保持页面活跃的小技巧
                setInterval(() => {
                  // 触发无害的微任务
                  Promise.resolve();
                }, 1000);

                document.title = '灰度辅助运行中';
              })();
            </script>
          </body>
          </html>
        `);
        helperTab.document.close();
        console.log('[灰度自动上线] 🛰️  已创建 Helper tab');
      }
    } catch (e) {
      console.warn('[灰度自动上线] ⚠️  Helper tab 创建失败（可能被浏览器拦截）:', e.message);
    }
  }

  // ==================== Web Worker 策略 ====================

  /**
   * Web Worker 高频心跳
   * 注意：Chrome 后台 tab 也会节流 Worker postMessage 的派发，
   * 但节流粒度是 1 秒（比主线程的 60 秒更频繁）
   */
  function createHeartbeatWorker() {
    const workerCode = `
      let count = 0;
      let timerId = null;

      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (timerId) clearInterval(timerId);
          timerId = setInterval(() => {
            count++;
            self.postMessage({ tick: count, ts: Date.now() });
          }, ${HEARTBEAT_INTERVAL});
        } else if (e.data === 'stop') {
          clearInterval(timerId);
          timerId = null;
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);

    worker.onmessage = (e) => {
      // Worker 心跳触发时执行检测（即使在后台也比主线程 60s 节流好得多）
      checkAndClick('worker');
    };

    worker.postMessage('start');
  }

  // ==================== 定时器管理 ====================

  function startPolling() {
    // 主线程高频轮询（前台时正常工作）
    pollTimer = setInterval(() => {
      checkAndClick('main');
    }, POLL_INTERVAL);

    // Worker 心跳（1 秒一次，后台被节流到 1 秒仍然有效）
    createHeartbeatWorker();

    // Helper tab 心跳（5 秒一次，前台触发，绕过主线程节流）
    setupHelperTab();
  }

  function stopAll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (worker) {
      worker.postMessage('stop');
      worker.terminate();
      worker = null;
    }
    if (helperTab && !helperTab.closed) {
      try { helperTab.close(); } catch (e) {}
    }
    if (broadcastChannel) {
      broadcastChannel.close();
      broadcastChannel = null;
    }
    stopDialogPolling();
  }

  // ==================== 启动 ====================

  function showStatus() {
    console.log(`
    ┌──────────────────────────────────────────┐
    │  🔧 灰度自动上线脚本 v1.3.0 已启动         │
    │  🔄 主轮询: 3 秒 (前台)                    │
    │  💬 弹窗轮询: 0.5 秒                       │
    │  💓 Worker 心跳: 1 秒 (后台仍有效)          │
    │  🛰️  Helper tab 心跳: 5 秒 (绕过主线程节流) │
    │  📍 visibilitychange 立即检查              │
    │  🎯 目标: ${window.location.href}          │
    └──────────────────────────────────────────┘
    `);
  }

  function init() {
    showStatus();

    setTimeout(() => checkAndClick('init'), 2000);

    startPolling();

    // 页面可见性变化时立即检查
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        console.log('[灰度自动上线] 📍 页面切回前台，立即检查...');
        checkAndClick('visibilitychange');
      } else {
        console.log('[灰度自动上线] 🌙 页面进入后台，依赖 Worker + Helper tab...');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', () => stopAll());
})();
