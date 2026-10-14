// Offline alpha.2 settings regression tests. Fixtures are Config.toJSON() from
// installed @deepseek-ai/dsh-llm-{pi-ai,deepseek} bundled with DSH 0.2.1-alpha.2.
// No browser, network, credentials store or real configuration writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSettingsService, catalogRowsFromModels, catalogRowToModel, catalogRowFromDiscoveredModel,
  inheritedProviderModels, settingsSchemaNodeAt, providerKeyCredential, providerKeyState,
  profilePathOps } from '../src/features/settings/settings-service.js';
import { protocolChoices, openCustomProvider } from '../src/app/sidepanel/settings/custom-provider-sheet.js';
import { createModelCatalogEditor } from '../src/app/sidepanel/settings/model-list-editor.js';
import { openProviderEditor } from '../src/app/sidepanel/settings/provider-editor-sheet.js';
import { createPresetsPane } from '../src/app/sidepanel/settings/presets-pane.js';
import { createGeneralPane } from '../src/app/sidepanel/settings/general-pane.js';
import { RPC } from '../src/platform/dsh/rpc-methods.js';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window; globalThis.document = dom.window.document;
const pi = JSON.parse(readFileSync(new URL('./fixtures/settings-alpha2-pi-schema.json', import.meta.url)));
const deepseek = JSON.parse(readFileSync(new URL('./fixtures/settings-alpha2-deepseek-schema.json', import.meta.url)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deps = { formatErrorDetails: e => e.message, settings: { getNotificationsEnabled: async () => false }, setLang() {} };
function sheet() {
  const root = document.createElement('div'); let generation = 0; let open = false;
  return { root, owns: token => open && token === generation,
    open({ body, actions, bind }) { open = true; generation++; root.innerHTML = '<div class="body">' + body + '</div><div class="actions">' + (actions ?? '') + '</div>'; bind?.(root, generation); return generation; },
    close(token) { if (token === generation) { open = false; generation++; root.innerHTML = ''; } },
    setBody(body, token) { if (this.owns(token)) root.querySelector('.body').innerHTML = body; },
    setActions(actions, token) { if (this.owns(token)) root.querySelector('.actions').innerHTML = actions; }
  };
}
function input(root, id, value) { const el = root.querySelector(id); el.value = value; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); return el; }
function providerHarness({ writable = true, credential = { configured: false, writable: true }, user = {}, base = {} } = {}) {
  const path = ['providers', 'test']; const ns = { ns: 'llm-pi-ai', revision: 9, schema: pi,
    base: { providers: { test: base } }, user: { providers: { test: user } }, value: { providers: { test: { ...base, ...user } } } };
  const entry = { provider: 'test', settingsNs: ns.ns, settingsPath: path, declared: true };
  let row = { entry, apiKeyEnv: null, derivedCredential: credential, settingsWritable: writable };
  const state = { rows: [row], namespaces: new Map([[ns.ns, ns]]), writable };
  const calls = []; const s = sheet();
  const handle = openProviderEditor({ entry, state, sheet: s, deps, rowFor: () => row,
    settingsService: { async mutate(...args) { calls.push(['mutate', ...args]); return { ...ns, revision: 10 }; }, async setCredential(...args) { calls.push(['credential', ...args]); } },
    translateSaveError: e => e.message });
  return { s, handle, state, calls, ns, setRow: next => { row = { ...row, ...next }; } };
}
test('actual schema ref graph finds protocol union and deepseek defaults, never unrelated consts', () => {
  const protocols = protocolChoices(pi); assert.ok(protocols.includes('openai-responses')); assert.ok(!protocols.includes('normal'));
  assert.equal(settingsSchemaNodeAt(pi, ['providers', 'any-route', 'defaultMaxTokens']).meta.default, 32768);
  const models = inheritedProviderModels({ schema: deepseek, base: {}, value: { models: [{ id: 'override' }] } });
  assert.equal(models.length, 2); assert.ok(models.every(model => model.id !== 'override'));
  assert.equal(settingsSchemaNodeAt(pi, ['missing']), undefined);
});
test('inherited models prefer pinned base including empty array over schema and effective override', () => {
  assert.deepEqual(inheritedProviderModels({ schema: deepseek, base: { models: [] }, value: { models: [{ id: 'old' }] } }), []);
  const pinned = [{ id: 'base' }]; assert.deepEqual(inheritedProviderModels({ schema: pi, base: { providers: { route: { models: pinned } } } }, ['providers', 'route']), pinned);
});
test('reset immediately restores inherited catalog and only unsets ownership for both families', () => {
  for (const allowFetch of [true, false]) {
    const editor = createModelCatalogEditor({ context: () => ({ inheritedModels: [{ id: 'base' }] }), allowFetch, requestRender() {} });
    editor.setRows(catalogRowsFromModels([{ id: 'override' }]), true); assert.match(editor.html(), /mle-reset/);
    editor.reset(); assert.equal(editor.rows[0].modelId, 'base'); assert.equal(editor.owned, false); assert.equal(editor.touched, true);
  }
});
test('model serialization preserves compat, reasoning, adapter field names and unknown metadata', () => {
  for (const field of ['input', 'inputModalities']) {
    const original = { id: 'm', name: 'Model', contextWindow: 128000, maxTokens: 8192,
      [field]: ['text', 'image'], compat: { nested: { untouched: true } }, reasoningEfforts: { low: 'small' }, description: 'Keep', custom: [1, 2] };
    const row = catalogRowsFromModels([original], field)[0]; assert.deepEqual(catalogRowToModel(row, field), original);
    row.name = 'Changed'; assert.deepEqual(catalogRowToModel(row, field), { ...original, name: 'Changed' });
    assert.deepEqual(original.compat, { nested: { untouched: true } });
  }
  const legacy = { id: 'legacy', inputModalities: ['text', 'image'] };
  assert.deepEqual(catalogRowToModel(catalogRowsFromModels([legacy], 'input')[0], 'input'), legacy);
});
test('discovery is normalized to pi profile input without importing catalog-only metadata', () => {
  const candidate = { id: 'm', name: 'Model', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'], description: 'Catalog-only' };
  const result = catalogRowToModel(catalogRowFromDiscoveredModel(candidate), 'input');
  assert.deepEqual(result, { id: 'm', name: 'Model', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] });
  const node = settingsSchemaNodeAt(pi, ['providers', 'r', 'models', '0']);
  assert.ok(Object.keys(result).every(key => key in node.dict));
});
test('readonly provider removal never unsets a managed credential first', async () => {
  const calls = []; const service = createSettingsService({ async call(...args) { calls.push(args); } });
  await service.removeProvider({ removable: true, settingsWritable: false, entry: { provider: 'r' }, apiKeyEnv: 'R_API_KEY', credential: { configured: true, writable: true } });
  assert.equal(calls.length, 0);
});
test('minimal profile operations do not rewrite headers/modelOverrides or unknown secrets', () => {
  const before = { headers: { Authorization: '<redacted>' }, modelOverrides: { a: { compat: { v: true } } }, baseURL: 'old' };
  assert.deepEqual(profilePathOps(['providers', 'r'], before, { ...before, baseURL: 'new' }), [{ op: 'set', path: ['providers', 'r', 'baseURL'], value: 'new' }]);
});
test('loadProviderRows describes derived refs without turning them into named authentication', async () => {
  let described; const service = createSettingsService({ async call(method, args) {
    if (method === RPC.llmConfigurableProviders) return [{ provider: 'test-route', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'test-route'] }];
    if (method === RPC.llmProviders) return [];
    if (method === RPC.settingsDescribe) return { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { 'test-route': { apiKeyEnv: '   ' } } } }] };
    if (method === RPC.credentialsDescribe) { described = args.refs; return { TEST_ROUTE_API_KEY: { configured: false, writable: false } }; }
  } });
  const { rows } = await service.loadProviderRows(); assert.deepEqual(described, ['TEST_ROUTE_API_KEY']);
  assert.equal(rows[0].credential, null); assert.equal(providerKeyCredential(rows[0]).writable, false);
  assert.equal(providerKeyState(rows[0]), 'notRequired');
  assert.equal(providerKeyState({ apiKeyEnv: 'REF', credential: null }), null);
});
test('host generation cache reset accepts low revision and late old replies never poison new cache', async () => {
  let resolveOld; let calls = 0;
  const service = createSettingsService({ call() { calls++; return calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ namespaces: [{ ns: 'n', revision: calls === 2 ? 1 : 2 }] }); } });
  const old = service.describe(); service.resetRevisionCache(); assert.equal((await service.describe()).namespaces[0].revision, 1);
  resolveOld({ namespaces: [{ ns: 'n', revision: 100 }] }); await old;
  assert.equal((await service.describe()).namespaces[0].revision, 2);
});
test('credential writable=false locks key even configured=false or absent, while profile remains editable', () => {
  for (const configured of [false, undefined]) { const h = providerHarness({ credential: { configured, writable: false } });
    assert.equal(h.s.root.querySelector('#prov-key').disabled, true); assert.equal(h.s.root.querySelector('#prov-baseurl').disabled, false); }
});
test('settings writable=false locks every editor field and write action', () => {
  const h = providerHarness({ writable: false, user: { models: [{ id: 'm' }] } });
  assert.ok([...h.s.root.querySelectorAll('input, select')].every(el => el.disabled));
  assert.equal(h.s.root.querySelector('#prov-save').disabled, true);
});
test('broadcast refreshFacts retains dirty input identity and opened revision, updates credential lock', async () => {
  const h = providerHarness(); const field = input(h.s.root, '#prov-baseurl', 'https://draft.invalid');
  h.setRow({ derivedCredential: { configured: false, writable: false } }); h.ns.revision = 99; h.handle.refreshFacts();
  assert.equal(h.s.root.querySelector('#prov-baseurl'), field); assert.equal(field.value, 'https://draft.invalid'); assert.equal(h.handle.dirty, true);
  assert.equal(h.s.root.querySelector('#prov-key').disabled, true); h.s.root.querySelector('#prov-save').click(); await tick();
  assert.equal(h.calls[0][3], 9); assert.deepEqual(h.calls[0][2], [{ op: 'set', path: ['providers', 'test', 'baseURL'], value: 'https://draft.invalid' }]);
});
test('provider reset sends unset only, does not echo old effective models', async () => {
  const h = providerHarness({ user: { models: [{ id: 'override' }] }, base: { models: [{ id: 'base' }] } });
  h.s.root.querySelector('#mle-reset').click(); assert.equal(h.s.root.querySelector('#mle-id-0').value, 'base');
  h.s.root.querySelector('#prov-save').click(); await tick(); assert.deepEqual(h.calls[0][2], [{ op: 'unset', path: ['providers', 'test', 'models'] }]);
});
test('custom sheet consumes fresh readonly state while retaining dirty draft DOM', () => {
  let state = { writable: true, rows: [], namespaces: new Map([['llm-pi-ai', { schema: pi, revision: 1 }]]) }; const s = sheet();
  const h = openCustomProvider({ state, getState: () => state, sheet: s, deps, settingsService: {}, translateSaveError: e => e.message });
  assert.equal(h.dirty, false); const field = input(s.root, '#cst-route', 'my-route');
  state = { ...state, writable: false }; h.refreshFacts(); assert.equal(s.root.querySelector('#cst-route'), field); assert.equal(field.value, 'my-route'); assert.equal(field.disabled, true);
});
test('retired modeSelectionEnabled never disables defaults or creator; YAML view never writes', async () => {
  const host = document.createElement('div'); const s = sheet(); const writes = []; let reads = 0;
  const presets = [{ id: 'standard', isDefault: true }, { id: 'cordis', isDefault: false }, { id: 'broken', broken: 'bad' }];
  const settingsService = { presetList: async () => ({ presets, modeSelectionEnabled: false }), describe: async () => ({ writable: true, namespaces: [{ ns: 'agent-preset-registry', revision: 1, value: { selectedDefault: 'standard' } }] }),
    presetRead: async id => { reads++; return { agentPreset: id, content: '- plugin: <script>alert(1)</script>\n' }; }, mutate: async (...args) => { writes.push(args); } };
  const pane = createPresetsPane({ host, sheet: s, deps, settingsService, onStartCreatorDraft() {} }); await pane.refresh();
  assert.equal(host.querySelector('#pset-picker'), null); assert.equal(host.querySelector('#pset-create-draft').disabled, false);
  assert.equal(host.querySelector('#pset-row-cordis').getAttribute('role'), 'button');
  host.querySelector('#pset-row-broken [data-preset-yaml]').click(); await tick(); assert.equal(reads, 1); assert.equal(writes.length, 0);
  assert.equal(s.root.querySelector('script'), null); assert.match(s.root.querySelector('code').textContent, /<script>/);
  const general = document.createElement('div'); await createGeneralPane({ host: general, deps, settingsService }).refresh();
  assert.equal(general.querySelector('#set-agent-preset').disabled, false);
});
test('late YAML response cannot overwrite another sheet', async () => {
  const host = document.createElement('div'); const s = sheet(); let finish;
  const pane = createPresetsPane({ host, sheet: s, deps, settingsService: { presetList: async () => ({ presets: [{ id: 'standard' }] }), describe: async () => ({ writable: false }), presetRead: () => new Promise(resolve => { finish = resolve; }) } });
  await pane.refresh(); host.querySelector('[data-preset-yaml]').click(); s.open({ body: 'Other sheet' });
  finish({ content: 'late YAML' }); await tick(); assert.equal(s.root.querySelector('.body').textContent, 'Other sheet');
});
