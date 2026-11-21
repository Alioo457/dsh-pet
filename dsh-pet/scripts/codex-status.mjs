/** Codex command hook for the Windows desktop app. The payload stays in memory. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const states = new Map([
  ['UserPromptSubmit', 'thinking'],
  ['PreToolUse', 'working'],
  ['PermissionRequest', 'waiting'],
  ['PostToolUse', 'result'],
  ['Stop', 'success'],
  ['Interrupt', 'idle'],
]);
const digest = (id) => createHash('sha256').update(id).digest('hex');

function saveStatus(localAppData) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { hook_event_name: event, session_id: sessionId, turn_id: turnId, tool_name: tool } = input;
  if (typeof sessionId !== 'string' || !sessionId) return;
  const directory = join(localAppData, 'dsh-pet', 'codex-status');
  const file = join(directory, digest(sessionId) + '.json');
  if (event === 'SessionEnd') {
    rmSync(file, { force: true });
    return;
  }

  let state = states.get(event);
  if (!state) return;
  if (event === 'PreToolUse' && (tool === 'request_user_input' || tool === 'request_user_input_async'))
    state = 'waiting';
  const turn = typeof turnId === 'string' && turnId ? digest(turnId) : null;
  if (event !== 'UserPromptSubmit') {
    let previous;
    try {
      previous = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // A session can be picked up after it has already started.
    }
    if (previous) {
      const finished = previous.state === 'idle' || previous.state === 'success';
      if (turn && previous.turn === turn && finished) return;
      // Ignore delayed tool or interrupt events from a previous turn.
      if (turn && previous.turn && previous.turn !== turn && !finished && Date.now() - previous.at < 30 * 60_000)
        return;
    }
  }

  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify({ state, turn, at: Date.now() }), { flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

try {
  if (process.env.LOCALAPPDATA) saveStatus(process.env.LOCALAPPDATA);
} catch {
  // A status display should never interrupt the Codex turn.
}
