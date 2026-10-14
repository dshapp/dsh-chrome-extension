import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountMainSurfaces } from "../src/app/sidepanel/main-surfaces.js";

function setup(pages, options = {}) {
  const dom = new JSDOM('<body><button data-main-surface="plugins"><span data-navigation-label></span></button><section id="management-surface" hidden><button id="management-back"></button><h1 id="management-title"></h1><div id="management-content"></div></section></body>');
  const errors = [];
  const controller = mountMainSurfaces(dom.window.document, { pages, onError: e => errors.push(e), ...options });
  return { dom, controller, errors };
}
test('closing a settings overlay before page switch cannot revive the hidden old page', async () => {
  const visibility = new Map(); let controller;
  const ui = setup(Object.fromEntries(['plugins','automations'].map(name => [name, {titleKey: 'management.'+name, mount: () => ({setVisible(v){visibility.set(name, v)}})}])), {beforeOpen: () => controller?.setSuspended(false)});
  controller = ui.controller;
  await controller.open('plugins'); controller.setSuspended(true);
  await controller.open('automations');
  assert.equal(visibility.get('plugins'), false); assert.equal(visibility.get('automations'), true);
  controller.setSuspended(false); assert.equal(visibility.get('plugins'), false);
  controller.dispose(); ui.dom.window.close();
});

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };

test('management surface lazily mounts, retains page state, suspends and restores conversation', async () => {
  let mounts = 0; const visibility = [];
  const { dom, controller } = setup({ plugins: { titleKey: 'management.plugins', mount(host) {
    mounts++; host.textContent = 'plugin state'; return { setVisible: v => visibility.push(v) };
  } } });
  assert.equal(controller.isOpen(), false);
  assert.equal(await controller.open('plugins'), true);
  assert.equal(dom.window.document.body.classList.contains('management-open'), true);
  assert.equal(dom.window.document.querySelector('[data-main-surface]').getAttribute('aria-pressed'), 'true');
  controller.setSuspended(true); controller.setSuspended(false);
  controller.close();
  assert.equal(controller.isOpen(), false);
  assert.equal(dom.window.document.querySelector('#management-surface').hidden, true);
  assert.equal(dom.window.document.body.classList.contains('management-open'), false);
  await controller.open('plugins');
  assert.equal(mounts, 1);
  assert.deepEqual(visibility, [false, true, false, true, false, true]);
  controller.dispose(); dom.window.close();
});

test('late mount cannot resurrect a management page after opening a session', async () => {
  const d = deferred(); const visibility = [];
  const { dom, controller } = setup({ plugins: { titleKey: 'management.plugins', mount: () => d.promise } });
  const opening = controller.open('plugins');
  await Promise.resolve(); controller.close();
  d.resolve({ setVisible: v => visibility.push(v) });
  assert.equal(await opening, false);
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(visibility, [false]);
  assert.equal(dom.window.document.querySelector('[data-page=plugins]').hidden, true);
  controller.dispose(); dom.window.close();
});

test('switching management pages stops old subscriptions and rejects stale opening', async () => {
  const d = deferred(); const calls = [];
  const { dom, controller } = setup({
    plugins: { titleKey: 'management.plugins', mount: () => d.promise },
    automations: { titleKey: 'management.automations', mount: () => ({ setVisible: v => calls.push(['auto', v]) }) }
  });
  const old = controller.open('plugins');
  await controller.open('automations');
  d.resolve({ setVisible: v => calls.push(['plugins', v]) });
  assert.equal(await old, false);
  assert.equal(controller.active(), 'automations');
  assert.deepEqual(calls, [['auto', false], ['auto', true], ['plugins', false]]);
  controller.dispose(); dom.window.close();
});

test('mount failures permit retry and report only current errors', async () => {
  let attempts = 0;
  const { dom, controller, errors } = setup({ plugins: { titleKey: 'management.plugins', mount() {
    if (++attempts === 1) throw new Error('unavailable'); return { refresh() {} };
  } } });
  assert.equal(await controller.open('plugins'), false);
  assert.equal(errors.length, 1);
  assert.equal(await controller.open('plugins'), true);
  assert.equal(dom.window.document.querySelectorAll('[data-page=plugins]').length, 1);
  controller.dispose(); dom.window.close();
});
