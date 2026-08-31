---
name: extension-local-dev
description: >-
  本地调试 DSH Chrome Bridge 扩展：改完代码重载扩展、打开并调试 sidepanel 页面。
  触发词：重载扩展、reload 扩展、打开 sidepanel、调试 sidepanel、本地 dev。
---

$extensionID=hjgcllfkbkhmggdopnfhhmaiaedacnpg

## 1. 重载扩展
1. 用chrome tool打开网页 `chrome://extensions/?id=$extensionID` 并active到这个tab
2. 用cu tool点击右上角的刷新图标重载扩展

## 2. 打开 sidepanel 调试
用chrome tool打开网页 `chrome-extension://{$extensionID}/pages/sidepanel/index.html`
当作普通网页调试.



