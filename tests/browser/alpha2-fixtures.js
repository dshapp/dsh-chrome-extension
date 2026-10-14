// Run from the extension page using dynamic import. No host writes or real installs.
import { createAutomationService, mountAutomationsPage } from '../../src/features/automations/index.js';
import { createServerPane } from '../../src/app/sidepanel/settings/server-pane.js';
import { openProviderEditor } from '../../src/app/sidepanel/settings/provider-editor-sheet.js';
import { createSheet } from '../../src/app/sidepanel/settings/settings-root.js';
import { t } from '../../src/shared/i18n.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b, message) => assert(stable(a) === stable(b), message);
function waitFor(root, predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => { if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve(); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Fixture condition timed out: '+(root.dataset.browserFixture ?? 'provider')+' '+predicate.toString())); }, 5000);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}
function change(root, selector, value, event = 'input') {
  const input = root.querySelector(selector); assert(input, 'Missing '+selector);
  input.value = value; input.dispatchEvent(new Event(event, { bubbles: true })); return input;
}
function click(root, key) {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent === t(key));
  assert(button, 'Missing button '+key); button.click(); return button;
}
function mountHost(label) {
  const host = document.createElement('section'); host.dataset.browserFixture = label;
  document.body.append(host); return host;
}
export async function runAlpha2BrowserFixtures() {
  const results = [];
  const host = mountHost('safe-update-channels');
  const queries = [], updates = []; let restarts = 0;
  const tags = { latest: '1.0.0', next: '1.1.0-rc.2', alpha: '2.0.0-alpha.10' };
  const deps = { connection: { streamState: 'connected', baseUrl: 'http://127.0.0.1:3080' }, DshStreamState: { CONNECTED: 'connected', CONNECTING: 'connecting' } };
  const pane = createServerPane({ host, deps, serverOps: {
    version: async (target = 'latest') => { queries.push(target); return { current: '1.0.0', latest: tags.latest, target, targetVersion: tags[target] ?? target, distTags: tags, updateSupported: true, updatable: target !== 'latest', checkFailed: false }; },
    update: async target => updates.push(target), restart: async () => restarts++
  } });
  try {
    await pane.refresh(); await waitFor(host, () => !!host.querySelector('#srv-dsh-channel'));
    change(host, '#srv-dsh-channel', 'next', 'change');
    await waitFor(host, () => !!host.querySelector('#srv-dsh-update') && !host.querySelector('#srv-dsh-update').disabled && host.textContent.includes(tags.next));
    host.querySelector('#srv-dsh-update').click();
    await waitFor(host, () => updates.length === 1 && host.querySelector('#srv-dsh-update').disabled && !host.querySelector('#srv-dsh-channel').disabled);
    change(host, '#srv-dsh-channel', 'alpha', 'change');
    await waitFor(host, () => !!host.querySelector('#srv-dsh-update') && !host.querySelector('#srv-dsh-update').disabled && host.textContent.includes(tags.alpha));
    change(host, '#srv-dsh-channel', 'exact', 'change');
    change(host, '#srv-dsh-exact', '1.2.3-alpha.10+build.01', 'change');
    await waitFor(host, () => !!host.querySelector('#srv-dsh-update') && !host.querySelector('#srv-dsh-update').disabled);
    host.querySelector('#srv-dsh-update').click();
    await waitFor(host, () => updates.length === 2 && host.querySelector('#srv-dsh-update').disabled && !host.querySelector('#srv-dsh-channel').disabled);
    equal(updates, ['next', '1.2.3-alpha.10+build.01'], 'Channel/exact update target mismatch');
    assert(restarts === 0, 'An update must not restart'); results.push('channel/exact selection, install completion and no auto-restart');
  } finally { pane.stop(); host.remove(); }
  const oldHost = mountHost('legacy-daemon');
  const old = createServerPane({ host: oldHost, deps, serverOps: { version: async () => ({ current: '0.9.0', latest: '1.0.0', updatable: true, updateSupported: false, targetVersion: '1.0.0' }) } });
  try {
    await old.refresh(); await waitFor(oldHost, () => !!oldHost.querySelector('#srv-dsh-channel'));
    assert(oldHost.querySelector('#srv-dsh-channel').disabled, 'Legacy daemon must not enable arbitrary channels');
    assert(!oldHost.querySelector('#srv-dsh-update').disabled, 'Legacy latest update remains available');
    results.push('old-daemon capability negotiation');
  } finally { old.stop(); oldHost.remove(); }
  results.push(...await runAutomationBrowserFixture());
  results.push(...await runProviderBrowserFixture());
  return { passed: results.length, cases: results, realWrites: 0, realInstalls: 0, realRestarts: 0, queriedTargets: queries };
}

async function runAutomationBrowserFixture() {
  const host = mountHost('automation-edit'); const calls = [], listeners = new Set();
  let entry = { id: 'fixture-schedule', sessionId: 'fixture-session', status: 'active', kind: 'weekly', title: 'Browser fixture review', prompt: 'Review synthetic data only', time: '10:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [1,2,3,4,5], scheduledAt: '2030-10-15T02:00:00.000Z' };
  let conflicts = true, created = 0;
  const connection = { onFrame: fn => { listeners.add(fn); return () => listeners.delete(fn); }, async call(method, args) {
    calls.push({ method, args });
    if (method === 'schedule/catalog') return entry ? [entry] : [];
    if (method === 'schedule/update') {
      if (conflicts) return { id: entry.id, updated: false, code: 'schedule_conflict' };
      entry = { ...entry, title: args.request.title }; return { id: entry.id, updated: true, record: { ...entry } };
    }
    if (method === 'schedule/history') return { id: entry.id, records: [{ messageId: args.request.before ? 'message-1' : 'message-2', prompt: 'Synthetic receipt, not model completion', scheduledAt: entry.scheduledAt, deliveredAt: entry.scheduledAt }], ...(args.request.before ? {} : { nextBefore: 'message-2' }), retention: { days: 30, records: 100 }, earlierRecordsPruned: true, earlierRecordsUnavailable: false };
    if (method === 'schedule/delete') { const id = entry.id; entry = null; return { id, deleted: true }; }
    throw Error('Unexpected fixture RPC '+method);
  } };
  const service = createAutomationService(connection);
  const page = mountAutomationsPage(host, { service, onNewSession: () => created++, sessions: { listStore: { get: () => [{ sessionId: 'fixture-session', title: 'Fixture only', origin: 'user' }], subscribe: () => () => {} }, archivedSessionIds: () => [] } });
  try {
    assert(listeners.size === 0, 'Hidden automations must not subscribe'); page.setVisible(true);
    await waitFor(host, () => !!host.querySelector('.automations-row'));
    click(host, 'automationsNew'); assert(created === 1, 'New action must delegate to a new-session callback');
    host.querySelector('.automations-row').click();
    const original = JSON.parse(JSON.stringify(entry));
    change(host, '[data-field=title]', 'Pending browser draft'); click(host, 'automationsSave');
    await waitFor(host, () => host.textContent.includes(t('automationsErrorConflict')));
    assert(host.querySelector('[data-field=title]').value === 'Pending browser draft', 'Conflict lost draft');
    const expected = calls.find(c => c.method === 'schedule/update').args.request.expected;
    const {sessionId, status, ...originalRecord} = original;
    equal(expected, originalRecord, 'Expected must contain the complete originally observed record');
    click(host, 'automationsCancel'); assert(host.querySelector('[data-field=title]').value === original.title, 'Cancel did not discard draft');
    conflicts = false; change(host, '[data-field=title]', 'Saved browser fixture'); click(host, 'automationsSave');
    await waitFor(host, () => host.querySelector('[data-field=title]')?.value === 'Saved browser fixture' && !host.querySelector('.automations-save-bar'));
    click(host, 'automationsTabRecords'); await waitFor(host, () => host.querySelectorAll('.automations-delivery').length === 1);
    click(host, 'automationsHistoryMore'); await waitFor(host, () => host.querySelectorAll('.automations-delivery').length === 2);
    assert(calls.filter(c => c.method === 'schedule/history')[1].args.request.before === 'message-2', 'History cursor is not exclusive message id');
    assert(host.textContent.includes(t('automationsHistoryDisclaimer')), 'Receipt must not claim model execution completed');
    click(host, 'automationsDelete'); assert(!calls.some(c => c.method === 'schedule/delete'), 'Delete bypassed confirmation');
    click(host, 'automationsDeleteConfirm'); await waitFor(host, () => !host.querySelector('.automations-detail'));
    page.setVisible(false); assert(listeners.size === 0, 'Hidden automations leaked subscriptions');
    assert(!calls.some(c => c.method.includes('create')), 'No schedule/create endpoint may be invented');
    return ['automation edit/cancel/conflict/full expected', 'exclusive history cursor and receipt disclaimer', 'delete confirmation and hidden-subscription cleanup'];
  } finally { page.dispose(); service.dispose(); host.remove(); }
}

async function runProviderBrowserFixture() {
  const schema = await (await fetch(new URL('../fixtures/settings-alpha2-pi-schema.json', import.meta.url))).json();
  const dialog = document.createElement('dialog'); dialog.innerHTML = '<h2 id="settings-sheet-title"></h2><div id="settings-sheet-body"></div><div id="settings-sheet-actions"></div>'; document.body.append(dialog);
  const sheet = createSheet(dialog); const calls = [];
  const ns = { ns: 'llm-pi-ai', revision: 9, schema, base: { providers: { fixture: { models: [{ id: 'inherited' }] } } }, user: { providers: { fixture: { models: [{ id: 'override' }] } } }, value: { providers: { fixture: { models: [{ id: 'override' }] } } } };
  const entry = { provider: 'fixture', settingsNs: ns.ns, settingsPath: ['providers','fixture'], declared: true };
  let row = { entry, apiKeyEnv: null, derivedCredential: { configured: false, writable: true }, settingsWritable: true };
  const state = { writable: true, rows: [row], namespaces: new Map([[ns.ns, ns]]) };
  const editor = openProviderEditor({ entry, state, sheet, rowFor: () => row, deps: { formatErrorDetails: e => e.message, models: { credentialFromEnv() {}, async discover() { return []; } } }, translateSaveError: e => e.message, settingsService: { async mutate(...args) { calls.push(args); return { ...ns, revision: 10 }; }, async setCredential() { throw Error('Must never write credential'); } } });
  try {
    const field = change(dialog, '#prov-baseurl', 'https://draft.invalid');
    row = { ...row, derivedCredential: { configured: false, writable: false } }; ns.revision = 99; editor.refreshFacts();
    assert(dialog.querySelector('#prov-baseurl') === field && field.value === 'https://draft.invalid', 'Soft facts refresh replaced dirty input');
    assert(dialog.querySelector('#prov-key').disabled, 'Readonly credential must be locked even when unconfigured');
    dialog.querySelector('#mle-reset').click();
    assert(dialog.querySelector('#mle-id-0').value === 'inherited', 'Reset did not show inherited models immediately');
    dialog.querySelector('#prov-save').click(); await waitFor(dialog, () => !dialog.open);
    assert(calls.length === 1 && calls[0][1].some(op => op.op === 'unset' && op.path.join('.') === 'providers.fixture.models'), 'Reset must send unset, not old effective models');
    assert(calls[0][2] === 9, 'Facts refresh must not advance expected revision of an open draft');
    return ['credential readonly and draft-preserving soft facts refresh', 'inherited model reset with unset-only ownership'];
  } finally { sheet.close(); dialog.remove(); }
}
