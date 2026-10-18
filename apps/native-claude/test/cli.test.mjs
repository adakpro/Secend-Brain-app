import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeCommands, codexEvent } from '../src/cli.mjs';

test('Codex uses official device login and a workspace sandbox', () => {
  const c = nativeCommands('codex');
  assert.deepEqual(c.login, ['login', '--device-auth']);
  assert.deepEqual(c.status, ['login', 'status']);
  assert.deepEqual(c.logout, ['logout']);
  assert.ok(c.exec.includes('workspace-write'));
  assert.ok(c.exec.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(c.exec.includes('--json'));
});
test('Codex failure and final message events are normalized', () => {
  assert.equal(codexEvent({ type: 'turn.failed' }).result.isError, true);
  assert.equal(codexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }).result.text, 'done');
});
