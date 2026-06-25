// ==UserScript==
// @name         Liteapp 灰度自动上线
// @namespace    https://lite.weixin.woa.com/
// @version      1.2.0
// @description  自动检测并点击"灰度上线"按钮，弹窗中自动确认。使用 Web Worker 对抗后台 tab 节流
// @author       xiaowuruan
// @match        https://lite.weixin.woa.com/console/*/release/change/info/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 常量 ====================

  const POLL_INTERVAL = 3000;            // 前台轮询间隔：3 秒
  const POLL_INTERVAL_BG = 60000;        // 后台轮询间隔：60 秒（对抗 intensive throttling）
  const DIALOG_POLL_INTERVAL = 500;      // 弹窗轮询：0.5 秒

  // ==================== 状态 ====================

  let pollTimer = null;
  let checkTimer = null;
  let dialogTimer = null;
  let lastClickTime = null;
  let isConfirming = false;
  let worker = null;
  let isInBackground = false;

  // ==================== 灰度上线按钮相关 ====================

  /**
   * 查找灰度上线按钮
   */
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

  /**
   * 判断按钮是否可点击
   */
  function isButtonEnabled(btn) {
    return !btn.disabled && !btn.classList.contains('t-is-disabled');
  }

  /**
   * 提取按钮上的倒计时秒数
   */
  function extractCountdown(btn) {
    const match = btn.textContent.match(/\((\d+)秒\)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // ==================== 弹窗确认相关 ====================

  /**
   * 查找灰度上线弹窗中的"确定"按钮
   * 注意：按钮在 .t-dialog__body > form 内，不在 .t-dialog__footer 中
   * 弹窗特征：标题为"灰度上线"，确认按钮文本为"确定"
   */
  function findDialogConfirmButton() {
    // 查找所有可见的弹窗
    const dialogs = document.querySelectorAll('.t-dialog__ctx');
    for (const dialog of dialogs) {
      const style = window.getComputedStyle(dialog);
      if (style.display === 'none') continue;

      // 确认是灰度上线弹窗（标题匹配）
      const title = dialog.querySelector('.t-dialog__header-content');
      if (!title || !title.textContent.includes('灰度上线')) continue;

      // 在弹窗中查找"确定"按钮
      const buttons = dialog.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '确定' && !btn.disabled) {
          return btn;
        }
      }
    }
    return null;
  }

  /**
   * 点击弹窗确认按钮
   */
  function clickDialogConfirm(btn) {
    console.log('[灰度自动上线] ✅ 点击弹窗确认按钮...');
    btn.click();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    isConfirming = false;
    console.log('[灰度自动上线] ✅ 弹窗已确认，等待下一轮灰度...');
  }

  /**
   * 启动弹窗检测
   */
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

    // 10 秒超时自动停止
    setTimeout(() => {
      if (dialogTimer) {
        console.log('[灰度自动上线] ⚠️ 弹窗检测超时，未找到确认按钮');
        stopDialogPolling();
        isConfirming = false;
      }
    }, 10000);
  }

  /**
   * 停止弹窗检测
   */
  function stopDialogPolling() {
    if (dialogTimer) {
      clearInterval(dialogTimer);
      dialogTimer = null;
    }
  }

  // ==================== 主逻辑 ====================

  /**
   * 点击灰度上线按钮
   */
  function clickGrayButton(btn) {
    console.log('[灰度自动上线] 🚀 点击灰度上线按钮...');
    lastClickTime = new Date();

    btn.disabled = false;
    btn.classList.remove('t-is-disabled');
    btn.click();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // 点击后立即启动弹窗检测
    startDialogPolling();
  }

  /**
   * 主检测逻辑
   */
  function checkAndClick() {
    const btn = findGrayButton();

    if (!btn) {
      console.log('[灰度自动上线] ⚠️ 未找到灰度上线按钮，可能已全部上线完成');
      stopAll();
      return;
    }

    const seconds = extractCountdown(btn);

    if (isButtonEnabled(btn)) {
      clickGrayButton(btn);
    } else if (seconds !== null && seconds <= 10) {
      console.log(`[灰度自动上线] ⏳ 倒计时 ${seconds} 秒，即将可点击...`);
    }
  }

  // ==================== Web Worker 心跳 ====================

  /**
   * 创建 Web Worker 用于后台心跳唤醒
   * Worker 不受 tab 节流影响，可以保持高频轮询
   */
  function createHeartbeatWorker() {
    const workerCode = `
      let interval = ${POLL_INTERVAL};
      let timerId = null;

      self.onmessage = function(e) {
        if (e.data === 'start') {
          timerId = setInterval(() => {
            self.postMessage('tick');
          }, interval);
        } else if (e.data === 'stop') {
          clearInterval(timerId);
          timerId = null;
        } else if (typeof e.data === 'number') {
          // 更新轮询间隔
          interval = e.data;
          if (timerId) {
            clearInterval(timerId);
            timerId = setInterval(() => {
              self.postMessage('tick');
            }, interval);
          }
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);

    worker.onmessage = () => {
      // Worker 心跳触发时执行检测
      if (!isConfirming) {
        checkAndClick();
      }
    };

    worker.postMessage('start');
  }

  // ==================== 定时器管理 ====================

  function startPolling() {
    // 主线程轮询（兜底）
    pollTimer = setInterval(() => {
      if (isConfirming) return;

      const btn = findGrayButton();
      if (!btn) {
        stopAll();
        return;
      }

      if (isButtonEnabled(btn)) {
        if (lastClickTime && (Date.now() - lastClickTime.getTime()) < 30000) {
          return;
        }
        clickGrayButton(btn);
      }
    }, POLL_INTERVAL);

    // 启动 Web Worker 心跳（不受 tab 节流影响）
    createHeartbeatWorker();
  }

  function stopAll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (worker) {
      worker.postMessage('stop');
      worker.terminate();
      worker = null;
    }
    stopDialogPolling();
  }

  // ==================== 启动 ====================

  function showStatus() {
    console.log(`
    ┌──────────────────────────────────────────┐
    │  🔧 灰度自动上线脚本 v1.2.0 已启动         │
    │  🔄 按钮轮询: 每 3 秒 (Web Worker 心跳)    │
    │  💬 弹窗轮询: 每 0.5 秒                    │
    │  ✅ 弹窗确认: 自动点击"确定"               │
    │  🛡️  后台抗节流: Web Worker 保活            │
    │  📍 页面切换前台时立即检查                  │
    │  🎯 目标: ${window.location.href}          │
    └──────────────────────────────────────────┘
    `);
  }

  function init() {
    showStatus();

    // 首次延迟检测
    setTimeout(() => checkAndClick(), 2000);

    // 启动主轮询 + Web Worker
    startPolling();

    // 监听页面可见性变化：从后台切回前台时立即检查
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        console.log('[灰度自动上线] 📍 页面切回前台，立即检查...');
        isInBackground = false;
        checkAndClick();
      } else {
        console.log('[灰度自动上线] 🌙 页面进入后台，依赖 Worker 心跳...');
        isInBackground = true;
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
