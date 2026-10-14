import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSessionService } from '../src/features/sessions/session-service.js';
import { mountSubagentCatalog } from '../src/features/subagents/subagent-catalog-view.js';
import { mountGoalBar, goalPhaseLabel } from '../src/features/docks/session-docks.js';
import { setLang } from '../src/shared/i18n.js';

function connection(value) { return { call: async () => value, onFrame: () => () => {}, subscribe() {}, unsubscribe() {} }; }

test('external catalog mode is retained and never read as a local child transcript', async () => {
  let calls = 0;
  const service = createSessionService({ ...connection(), call: async () => { calls++; return { values: { subagentCatalog: [{ id: 'external-child', mode: 'external', label: 'Remote worker' }] } }; } });
  const value = await service.listSubagents('parent');
  assert.equal(value.entries[0].mode, 'external');
  assert.equal(value.entries[0].hasChildren, false);
  assert.equal(await service.loadSubagentHistory({ parentSessionId: 'parent', childSessionId: 'external-child', mode: 'external' }), null);
  assert.equal(calls, 1);
});

test('external catalog rows are explicitly non-navigable while local children still open', async () => {
  const dom = new JSDOM('<button id="trigger"><span class="subagent-label"></span><span class="subagent-dot"></span></button><div id="menu"></div>');
  const saved = globalThis.document; globalThis.document = dom.window.document;
  try {
    const opened = [];
    const trigger = document.querySelector('#trigger'), menu = document.querySelector('#menu');
    const service = createSessionService(connection({ values: { subagentCatalog: [ { id: 'remote', mode: 'external', label: 'External worker' }, { id: 'local', mode: 'continuable', label: 'Local worker' } ] } }));
    service.listStore.replaceAll([{ sessionId: 'local', parentSessionId: 'parent', origin: 'subagent', title: 'Local worker' }]);
    mountSubagentCatalog(trigger, menu, { deps: { sessions: service }, getSessionId: () => 'parent', onOpenSubagent: a => opened.push(a) });
    const toggle = new dom.window.Event('toggle'); toggle.newState = 'open'; menu.dispatchEvent(toggle);
    await new Promise(resolve => setImmediate(resolve));
    const buttons = [...menu.querySelectorAll('.subagent-row-open')];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].disabled, true); buttons[0].click(); assert.equal(opened.length, 0);
    assert.equal(buttons[1].disabled, false); buttons[1].click(); assert.equal(opened.length, 1);
    assert.equal(opened[0].childSessionId, 'local');
    const close = new dom.window.Event('toggle'); close.newState = 'closed'; menu.dispatchEvent(close);
  } finally { globalThis.document = saved; dom.window.close(); }
});

test('active disarmed goal shows Awaiting resume and only resumes after explicit action', async () => {
  const dom = new JSDOM('<div id="goal"></div>'); const saved = globalThis.document;
  globalThis.document = dom.window.document; setLang('en');
  try {
    let resumes = 0, pauses = 0;
    const host = document.querySelector('#goal');
    const bar = mountGoalBar(host, { onResume: () => resumes++, onPause: () => pauses++, onEdit() {}, onClear() {} });
    bar.set({ id: 'g', revision: 1, phase: 'active', activation: 'disarmed', objective: 'Upgrade' });
    assert.equal(goalPhaseLabel('active', 'disarmed'), 'Awaiting resume');
    assert.equal(host.querySelector('.goal-label').textContent, 'Awaiting resume');
    assert.equal(resumes, 0);
    const resume = host.querySelector('[aria-label="Resume goal"]'); assert.ok(resume); resume.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resumes, 1); assert.equal(pauses, 0);
  } finally { globalThis.document = saved; setLang('zh'); dom.window.close(); }
});
