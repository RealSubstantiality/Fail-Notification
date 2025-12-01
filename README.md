# Fail Notification — SillyTavern 扩展
SillyTavern自带回复成功后播放提示音功能，但是生成失败后没有提示。

本扩展可以在生成失败/空回复时播放自定义提示音（成功时不响）。

## 安装
SillyTavern → Extensions → Manage → Install from Git  
粘贴：
https://github.com/RealSubstantiality/fail-notification.git

安装后在扩展列表里启用；首次任意点击页面以解锁浏览器音频。

## 2025.12.1更新说明
在扩展管理页中增加设置面板。
增加Android设备的振动提示功能。

## 自定义声音
将 `fail.mp3` 替换为你自己的音效文件（同名覆盖）。

提供SillyTavern自带的回复成功音效（fail1.mp3）作为备选。

## 兼容性（AI说的，我也看不懂）
- 不依赖事件总线；通过 `generate_interceptor` + fetch/XHR 勾子工作  

## 更新
从 Git 重新安装或在扩展管理里点 Update。

## License
MIT
