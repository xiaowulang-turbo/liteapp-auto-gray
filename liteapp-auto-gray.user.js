// ==UserScript==
// @name         Liteapp 灰度自动上线
// @namespace    https://lite.weixin.woa.com/
// @version      1.4.0
// @description  自动检测并点击"灰度上线"按钮，弹窗中自动确认。使用静音音频循环播放对抗 Chrome 后台 tab 节流（Intensive Throttling）
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

  // ==================== 灰度上线按钮 ====================

  function findGrayButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim().includes('灰度上线')) {
        return btn;
      }
    }
    return null;
  }

  function isButtonEnabled(btn) {
    return !btn.disabled && !btn.classList.contains('t-is-disabled');
  }

  // ==================== 弹窗确认 ====================

  function findDialogConfirmButton() {
    const dialogs = document.querySelectorAll('.t-dialog__ctx');
    for (const dialog of dialogs) {
      if (window.getComputedStyle(dialog).display === 'none') continue;

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
    if (!btn) return;

    if (isButtonEnabled(btn)) {
      if (lastClickTime && (Date.now() - lastClickTime.getTime()) < 30000) {
        return;
      }
      console.log(`[灰度自动上线] 🎯 检测到可点击按钮 (来源: ${source}, hidden: ${document.hidden})`);
      clickGrayButton(btn);
    }
  }

  // ==================== 静音音频保活（核心）====================

  /**
   * 播放静音音频，让 Chrome 认为 tab 在"播放媒体"
   * 这样可以绕过 Intensive Throttling（后台 5 分钟后节流到 1 分钟）
   *
   * 原理：Chrome 的 Intensive Throttling 会跳过正在播放音频的 tab
   * 因此播放一段无限循环的静音，可以让 tab 保持"活跃"状态
   *
   * 注意：需要用户手势才能启动 AudioContext（autoplay policy）
   */
  function startSilentAudio() {
    if (audioActivated) return;

    try {
      const AudioContextCls = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCls) {
        console.warn('[灰度自动上线] ⚠️ 浏览器不支持 AudioContext');
        return;
      }

      audioCtx = new AudioContextCls();

      // 创建一个无限循环的静音 buffer
      const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
      // 全零，静音

      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      // 通过 GainNode 设为音量 0（双重保险）
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;

      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      source.start(0);

      audioNode = source;

      // 检查 audioCtx 状态
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
          audioActivated = true;
          console.log('[灰度自动上线] 🎵 静音音频保活已激活（AudioContext resumed）');
        }).catch(e => {
          console.warn('[灰度自动上线] ⚠️ AudioContext resume 失败:', e.message);
        });
      } else {
        audioActivated = true;
        console.log('[灰度自动上线] 🎵 静音音频保活已激活');
      }
    } catch (e) {
      console.warn('[灰度自动上线] ⚠️ 静音音频启动失败:', e.message);
    }
  }

  /**
   * 由于 autoplay policy，AudioContext 必须在用户交互后才能启动
   * 因此监听一次性用户交互事件来激活音频
   */
  function setupAudioActivation() {
    const activate = () => {
      startSilentAudio();
      // 只需激活一次，然后移除监听
      ['click', 'keydown', 'touchstart', 'mousedown'].forEach(evt => {
        window.removeEventListener(evt, activate, true);
      });
    };

    // 尝试立即启动（部分浏览器/场景可能已经允许）
    startSilentAudio();

    // 如果失败，等待用户交互
    if (!audioActivated) {
      ['click', 'keydown', 'touchstart', 'mousedown'].forEach(evt => {
        window.addEventListener(evt, activate, true);
      });
      console.log('[灰度自动上线] 💡 请在页面任意位置点击一次以激活后台保活');
    }
  }

  // ==================== Wake Lock（辅助）====================

  /**
   * 请求 Screen Wake Lock，防止屏幕休眠导致 tab 被冻结
   * 注意：wakeLock 主要防屏幕休眠，对 tab 后台节流帮助有限
   */
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;

    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('[灰度自动上线] 🔒 Wake Lock 已获取');

      wakeLock.addEventListener('release', () => {
        console.log('[灰度自动上线] 🔓 Wake Lock 已释放');
      });

      // 页面回到前台时重新请求（Chrome 会在切走时自动释放）
      document.addEventListener('visibilitychange', async () => {
        if (!document.hidden && !wakeLock) {
          try {
            wakeLock = await navigator.wakeLock.request('screen');
          } catch (e) {}
        }
      });
    } catch (e) {
      console.warn('[灰度自动上线] ⚠️ Wake Lock 失败:', e.message);
    }
  }

  // ==================== Web Worker 心跳（辅助）====================

  /**
   * Worker 心跳配合静音音频后：
   * - 有音频保活时：Worker 每 2 秒精准派发
   * - 无音频保活时：后台 5 分钟后被节流到 1 分钟
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
            self.postMessage({ tick: count });
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

    worker.onmessage = () => {
      checkAndClick('worker');
    };

    worker.postMessage('start');
  }

  // ==================== 定时器管理 ====================

  function startPolling() {
    pollTimer = setInterval(() => {
      checkAndClick('main');
    }, POLL_INTERVAL);

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
    │  🔧 灰度自动上线脚本 v1.4.0 已启动         │
    │  🎵 静音音频保活: 绕过 Intensive Throttling │
    │  💓 Worker 心跳: 每 2 秒                    │
    │  🔒 Wake Lock: 防屏幕休眠                   │
    │  🔄 主轮询: 3 秒                            │
    │  💬 弹窗轮询: 0.5 秒                        │
    │  📍 切回前台立即检查                        │
    │  💡 首次使用请点击页面激活音频               │
    └──────────────────────────────────────────┘
    `);
  }

  function init() {
    showStatus();

    // 启动主循环
    setTimeout(() => checkAndClick('init'), 2000);
    startPolling();

    // 启动保活机制
    setupAudioActivation();
    requestWakeLock();

    // 可见性监听
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        console.log('[灰度自动上线] 📍 页面切回前台，立即检查...');
        checkAndClick('visibilitychange');
      } else {
        console.log(`[灰度自动上线] 🌙 页面进入后台，音频保活: ${audioActivated ? '已激活' : '未激活'}`);
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
