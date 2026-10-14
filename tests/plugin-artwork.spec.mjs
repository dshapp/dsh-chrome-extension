/**
 * 插件管理页图标:接口自带的 meta.icon 直接当 <img> 画,缺失 / 非法 / 解码失败时回落
 * 到 DSH web 同位置的默认图;官方配置卡片用 web 的固定图。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { packageArtwork, cardArtwork } = await import("../src/app/sidepanel/settings/plugin-artwork.js");

const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const mount = (html) => { document.body.innerHTML = html; return document.body.firstElementChild; };

test("有接口图标:画成 <img>,src 原样就是 meta.icon,回落图藏在旁边", () => {
  const node = mount(packageArtwork(ICON));
  const img = node.querySelector("img.plug-icon-img");
  assert.equal(img.getAttribute("src"), ICON);
  assert.ok(node.querySelector(".plug-icon-fallback svg"));
  assert.equal(node.classList.contains("lg"), false);
});

test("没有图标或不是图片 data URL:直接画默认图,不出 <img>", () => {
  for (const src of [undefined, "", "https://example.com/x.png", "javascript:alert(1)", "data:text/html;base64,AAAA"]) {
    const node = mount(packageArtwork(src));
    assert.equal(node.querySelector("img"), null, String(src));
    assert.ok(node.querySelector("svg"));
  }
});

test("插件包默认图与包内组件默认图不同(web: Default / Subagent)", () => {
  const bundle = mount(packageArtwork(undefined)).innerHTML;
  const component = mount(packageArtwork(undefined, { component: true })).innerHTML;
  assert.match(bundle, /#54ECE7/);
  assert.match(component, /#45E7A4/);
});

test("图片解码失败:框被标成 failed,换上回落图", () => {
  const node = mount(packageArtwork(ICON, { size: "lg" }));
  assert.ok(node.classList.contains("lg"));
  node.querySelector("img").dispatchEvent(new window.Event("error"));
  assert.ok(node.classList.contains("failed"));
});

test("官方配置卡片用 web 的固定图;同页多次渲染的渐变 id 不重复", () => {
  assert.match(mount(cardArtwork("bash")).innerHTML, /#679EFE/);
  assert.match(mount(cardArtwork("agent-loop")).innerHTML, /#A797FC/);
  assert.match(mount(cardArtwork("web-search")).innerHTML, /conic-gradient/);
  assert.match(mount(cardArtwork("unknown")).innerHTML, /#54ECE7/);
  document.body.innerHTML = cardArtwork("subagent") + cardArtwork("subagent");
  const ids = [...document.querySelectorAll("linearGradient")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
});
