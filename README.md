# Liteapp 灰度自动上线

油猴脚本（Tampermonkey），自动检测并点击 Liteapp 运营平台的「灰度上线」和「结单」按钮，弹窗自动确认，实现从灰度发布到结单的**全流程自动化**。

## 一键安装

**点击下方链接**，Tampermonkey 会自动识别并弹出安装界面：

👉 [**安装 / 更新脚本**](https://raw.githubusercontent.com/xiaowulang-turbo/liteapp-auto-gray/main/liteapp-auto-gray.user.js)

首次安装后，Tampermonkey 会**自动检查更新**（默认每天一次），你也可以在扩展面板手动「检查外部更新」。

## 匹配页面

```
https://lite.weixin.woa.com/console/*/release/change/info/*
```

## 特性

| 功能 | 说明 |
|------|------|
| 🚀 **灰度上线自动点击** | 倒计时结束立即触发 |
| ✅ **弹窗自动确认** | 支持 TDesign footer 按钮和 body/form 自定义按钮两种结构 |
| 🎯 **结单自动化** | 全面上线后自动点击「结单」并确认 |
| 🎵 **静音音频保活** | 绕过 Chrome 后台 tab 的 Intensive Throttling |
| 💓 **Web Worker 心跳** | 双重保障，2 秒精准轮询 |
| 🔒 **Wake Lock** | 防屏幕休眠 |
| 🔄 **自动更新** | 通过 `@updateURL` 自动检查新版本 |

## 工作流程

```
灰度 1% → 5% → 10% → 20% → 50% → 全面上线
    ↓ (每一步倒计时结束)
自动点击「灰度上线」→ 弹窗「灰度上线」→ 自动点「确定」
    ↓ (状态变为已全面上线)
自动点击「结单」→ 弹窗「确认结单吗？」→ 自动点「确定」
    ↓
完成 ✅
```

## 后台 Tab 保活原理

Chrome 对后台 tab 有严格的定时器节流策略：

- **Timer Throttling** (< 5 分钟)：setInterval 被限制到 ≥ 1 秒
- **Intensive Throttling** (> 5 分钟)：setInterval 被限制到 ≥ 60 秒

本脚本使用**静音音频循环播放**（Web Audio API + GainNode 音量 0），让 Chrome 认为 tab 在"播放媒体"，从而完全绕过 Intensive Throttling。

**首次使用请点击页面任意位置一次**，以激活 AudioContext（Chrome autoplay policy 要求）。

## 日志

打开控制台（F12）可查看运行日志：

```
[自动上线] 🎵 静音音频保活已激活
[自动上线] 🎯 检测到"灰度上线"可点击 (来源: worker, hidden: true)
[自动上线] 🚀 点击"灰度上线"按钮...
[自动上线] 🔍 检测"灰度上线"确认弹窗...
[自动上线] ✅ 点击弹窗"确定"按钮...
```

## 版本历史

- **v1.5.1** — 增加 `@updateURL` `@downloadURL`，支持 Tampermonkey 自动更新
- **v1.5.0** — 新增结单按钮自动化，通用弹窗匹配
- **v1.4.0** — 静音音频保活，替代无效的 helper tab 方案
- **v1.3.0** — 尝试 helper tab 方案（后废弃）
- **v1.2.0** — Web Worker 心跳
- **v1.1.0** — 弹窗自动确认
- **v1.0.0** — 灰度上线按钮自动点击

## License

MIT
