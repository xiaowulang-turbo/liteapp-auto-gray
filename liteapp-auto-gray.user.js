// ==UserScript==
// @name         Liteapp 灰度自动上线
// @namespace    https://lite.weixin.woa.com/
// @version      1.5.0
// @description  自动检测并点击"灰度上线"和"结单"按钮，弹窗中自动确认。使用静音音频循环播放对抗 Chrome 后台 tab 节流
// @author       xiaowuruan
// @match        https://lite.weixin.woa.com/console/*/release/change/info/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 常量 ====================

  const POLL_INTERVAL = 3000;            // 主轮询：3 秒
  const DIALOG_POLL_INTERVAL = 500;      // 弹窗轮询：0.5 秒
  const HEARTBEAT_INTERVAL = 2000;       // Worker 心跳：2 秒
  const DIALOG_TIMEOUT = 10000;          // 弹窗检测超时：10 秒
  const REPEAT_COOLDOWN = 30000;         // 重复点击冷却：30 秒

  // 目标按钮定义
  const TARGETS = [
    {
      name: '灰度上线',
      match: (btn) => btn.textContent.trim().includes('灰度上线'),
      dialogTitle: '灰度上线',
    },
    {
      name: '结单',
      match: (btn) => btn.textContent.trim() === '结单',
      dialogTitle: '结单',
    },
  ];

  // ==================== 状态 ====================

  let pollTimer = null;
  let dialogTimer = null;
  let lastClickTime = null;
  let isConfirming = false;
  let worker = null;
  let audioCtx = null;
  let audioNode = null;
  let wakeLock = null;
  let audioActivated = false;

  // ==================== 按钮查找 ====================

  /**
   * 按优先级查找目标按钮（灰度上线 > 结单）
   * 返回 { btn, target } 或 null
   */
  function findTargetButton() {
    const buttons = document.querySelectorAll('button');
    for (const target of TARGETS) {
      for (const btn of buttons) {
        if (target.match(btn)) {
          return { btn, target };
        }
      }
    }
    return null;
  }

  function isButtonEnabled(btn) {
    return !btn.disabled && !btn.classList.contains('t-is-disabled');
  }

  // ==================== 弹窗确认 ====================

  /**
   * 查找可见弹窗中的"确定"按钮
   * 支持两种结构：
   *   1) TDesign 标准 footer 按钮（class 含 t-dialog__confirm，如"结单"弹窗）
   *   2) body/form 中的自定义确定按钮（如"灰度上线"弹窗）
   */
  function findDialogConfirmButton(dialogTitleKeyword) {
    const dialogs = document.querySelectorAll('.t-dialog__ctx');
    for (const dialog of dialogs) {
      if (window.getComputedStyle(dialog).display === 'none') continue;

      // 通过标题关键字锁定弹窗，避免误点其他弹窗
      const title = dialog.querySelector('.t-dialog__header-content');
      if (!title || !title.textContent.includes(dialogTitleKeyword)) continue;

      // 优先：TDesign 标准 footer 确认按钮
      const stdConfirm = dialog.querySelector('.t-dialog__confirm');
      if (stdConfirm && !stdConfirm.disabled) {
        return stdConfirm;
      }

      // 兜底：文本为"确定"的按钮
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
    console.log('[自动上线] ✅ 点击弹窗"确定"按钮...');
    btn.click();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    isConfirming = false;
    console.log('[自动上线] ✅ 弹窗已确认');
  }

  function startDialogPolling(dialogTitleKeyword) {
    if (dialogTimer) return;
    isConfirming = true;

    console.log(`[自动上线] 🔍 检测"${dialogTitleKeyword}"确认弹窗...`);
    dialogTimer = setInterval(() => {
      const confirmBtn = findDialogConfirmButton(dialogTitleKeyword);
      if (confirmBtn) {
        clickDialogConfirm(confirmBtn);
        stopDialogPolling();
      }
    }, DIALOG_POLL_INTERVAL);

    setTimeout(() => {
      if (dialogTimer) {
        console.log('[自动上线] ⚠️ 弹窗检测超时');
        stopDialogPolling();
        isConfirming = false;
      }
    }, DIALOG_TIMEOUT);
  }

  function stopDialogPolling() {
    if (dialogTimer) {
      clearInterval(dialogTimer);
      dialogTimer = null;
    }
  }

  // ==================== 主逻辑 ====================

  function clickTargetButton(btn, target) {
    console.log(`[自动上线] 🚀 点击"${target.name}"按钮...`);
    lastClickTime = new Date();

    btn.disabled = false;
    btn.classList.remove('t-is-disabled');
    btn.click();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    startDialogPolling(target.dialogTitle);
  }

  function checkAndClick(source) {
    if (isConfirming) return;

    const found = findTargetButton();
    if (!found) return;

    const { btn, target } = found;
    if (!isButtonEnabled(btn)) return;

    if (lastClickTime && (Date.now() - lastClickTime.getTime()) < REPEAT_COOLDOWN) {
      return;
    }

    console.log(`[自动上线] 🎯 检测到"${target.name}"可点击 (来源: ${source}, hidden: ${document.hidden})`);
    clickTargetButton(btn, target);
  }

  // ==================== 静音音频保活 ====================

  function startSilentAudio() {
    if (audioActivated) return;

    try {
      const AudioContextCls = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCls) return;

      audioCtx = new AudioContextCls();

      const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;

      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      source.start(0);

      audioNode = source;

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
          audioActivated = true;
          console.log('[自动上线] 🎵 静音音频保活已激活');
        }).catch(() => {});
      } else {
        audioActivated = true;
        console.log('[自动上线] 🎵 静音音频保活已激活');
      }
    } catch (e) {
      console.warn('[自动上线] ⚠️ 静音音频启动失败:', e.message);
    }
  }

  function setupAudioActivation() {
    const activate = () => {
      startSilentAudio();
      ['click', 'keydown', 'touchstart', 'mousedown'].forEach(evt => {
        window.removeEventListener(evt, activate, true);
      });
    };

    startSilentAudio();

    if (!audioActivated) {
      ['click', 'keydown', 'touchstart', 'mousedown'].forEach(evt => {
        window.addEventListener(evt, activate, true);
      });
      console.log('[自动上线] 💡 请点击页面一次以激活后台保活');
    }
  }

  // ==================== Wake Lock ====================

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;

    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });

      document.addEventListener('visibilitychange', async () => {
        if (!document.hidden && !wakeLock) {
          try {
            wakeLock = await navigator.wakeLock.request('screen');
          } catch (e) {}
        }
      });
    } catch (e) {}
  }

  // ==================== Web Worker 心跳 ====================

  function createHeartbeatWorker() {
    const workerCode = `
      let timerId = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (timerId) clearInterval(timerId);
          timerId = setInterval(() => self.postMessage('tick'), ${HEARTBEAT_INTERVAL});
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

    worker.onmessage = () => checkAndClick('worker');
    worker.postMessage('start');
  }

  // ==================== 定时器管理 ====================

  function startPolling() {
    pollTimer = setInterval(() => checkAndClick('main'), POLL_INTERVAL);
    createHeartbeatWorker();
  }

  function stopAll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (worker) {
      worker.postMessage('stop');
      worker.terminate();
      worker = null;
    }
    if (audioNode) {
      try { audioNode.stop(); } catch (e) {}
      audioNode = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
    }
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
    stopDialogPolling();
  }

  // ==================== 启动 ====================

  function showStatus() {
    console.log(`
    ┌──────────────────────────────────────────┐
    │  🔧 Liteapp 自动上线脚本 v1.5.0 已启动     │
    │  🎯 目标按钮: 灰度上线 → 结单              │
    │  🎵 静音音频保活: 绕过后台节流              │
    │  💓 Worker 心跳: 每 2 秒                    │
    │  🔄 主轮询: 3 秒 / 弹窗轮询: 0.5 秒         │
    │  💡 首次使用请点击页面激活音频               │
    └──────────────────────────────────────────┘
    `);
  }

  function init() {
    showStatus();

    setTimeout(() => checkAndClick('init'), 2000);
    startPolling();

    setupAudioActivation();
    requestWakeLock();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        console.log('[自动上线] 📍 页面切回前台，立即检查...');
        checkAndClick('visibilitychange');
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
