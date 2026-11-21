import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readCodexWorkStatus } from './codex-status.ts';

const hook = fileURLToPath(new URL('../../scripts/codex-status.mjs', import.meta.url));

test('钩子只存状态并按会话聚合，完成或中断一个回合时保留其他会话', async () => {
  const data = await mkdtemp(join(tmpdir(), 'dsh-codex-'));
  const directory = join(data, 'dsh-pet', 'codex-status');
  const emit = (hook_event_name: string, session_id: string, turn_id = 'turn-1') => {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id, turn_id, hook_event_name, prompt: '不应落盘的文本' }),
      env: { ...process.env, LOCALAPPDATA: data },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  };
  try {
    assert.equal(await readCodexWorkStatus(directory), null);
    emit('UserPromptSubmit', 'chat-a');
    assert.equal(await readCodexWorkStatus(directory), 'thinking');
    emit('PreToolUse', 'chat-a');
    assert.equal(await readCodexWorkStatus(directory), 'working');
    emit('PermissionRequest', 'chat-b');
    assert.equal(await readCodexWorkStatus(directory), 'waiting');
    emit('Stop', 'chat-b');
    assert.equal(await readCodexWorkStatus(directory), 'working');
    emit('PostToolUse', 'chat-a');
    assert.equal(await readCodexWorkStatus(directory), 'result');
    emit('Interrupt', 'chat-a');
    emit('PostToolUse', 'chat-a');
    assert.equal(await readCodexWorkStatus(directory), 'success');
    emit('SessionEnd', 'chat-b');
    assert.equal(await readCodexWorkStatus(directory), null);
    emit('UserPromptSubmit', 'chat-a', 'turn-2');
    emit('Interrupt', 'chat-a', 'turn-1');
    assert.equal(await readCodexWorkStatus(directory), 'thinking');
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[\da-f]{64}\.json$/);
    const entry = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'state', 'turn'].sort());
    assert.equal(await readCodexWorkStatus(directory, Date.now() + 31 * 60_000), null);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('忽略无效、过大的、未来的及已过期的状态快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-invalid-'));
  const write = (id: string, value: string) => writeFile(join(directory, id.repeat(64) + '.json'), value);
  const now = Date.now();
  try {
    await mkdir(join(directory, 'a'.repeat(64) + '.json'));
    await write('b', '{');
    await write('c', JSON.stringify({ state: 'waiting', at: now + 60_000 }));
    await write('d', JSON.stringify({ state: 'waiting', at: now, extra: 'a'.repeat(400) }));
    await write('e', JSON.stringify({ state: 'success', at: now - 20_000 }));
    await write('f', JSON.stringify({ state: 'unknown', at: now }));
    assert.equal(await readCodexWorkStatus(directory, now), null);
    await write('e', JSON.stringify({ state: 'success', at: now }));
    assert.equal(await readCodexWorkStatus(directory, now), 'success');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
