import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsNotifications } from '../src/features/settings/settings-notifications.js';

function fixture() {
  const listeners = new Set(); let changes = 0, resets = 0;
  const controller = createSettingsNotifications({ onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); } }, { onChange: () => { changes++; }, onReset: () => { resets++; } });
  const send = value => { for (const fn of listeners) fn({ type: 'item', streamId: 'events', value }); };
  return { controller, listeners, send, get changes() { return changes; }, get resets() { return resets; } };
}
const updated = (ns, revision) => ({ type: 'emit', event: 'settings/document-updated', args: [ns, revision] });

test('settings notifications subscribe only while visible and coalesce revision updates without touching drafts', async () => {
  const f = fixture(); assert.equal(f.listeners.size, 0);
  f.controller.setVisible(true); assert.equal(f.listeners.size, 1);
  f.send(updated('llm-deepseek', 2)); f.send(updated('llm-deepseek', 2)); f.send(updated('llm-deepseek', 1));
  f.send({ type: 'emit', event: 'credentials/reference-updated', args: [{ provider: 'keychain' }] });
  await Promise.resolve(); assert.equal(f.changes, 1);
  f.send(updated('other', 1)); f.controller.setVisible(false);
  await Promise.resolve(); assert.equal(f.changes, 1); assert.equal(f.listeners.size, 0);
  f.controller.dispose();
});

test('reconnection discards old revisions and rereads new generation even at lower revision', async () => {
  const f = fixture(); f.controller.setVisible(true);
  f.send(updated('provider', 12)); await Promise.resolve();
  f.send({ type: 'ready' }); await Promise.resolve(); assert.equal(f.resets, 1);
  f.send(updated('provider', 1)); await Promise.resolve(); assert.equal(f.changes, 3);
  f.controller.dispose(); assert.equal(f.listeners.size, 0);
});
