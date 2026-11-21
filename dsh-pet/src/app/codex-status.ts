import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HOST_WORK_STATUS_STATES, WORK_STATUS_PRIORITY, type HostWorkStatusState } from '../host/work-status.ts';

const MAX_SNAPSHOT_BYTES = 256;
const ACTIVE_TTL_MS = 30 * 60_000;
const COMPLETE_TTL_MS = 8_000;

/** Read current events from the local Codex hook. Expired files have no effect. */
export async function readCodexWorkStatus(directory: string, now = Date.now()): Promise<HostWorkStatusState | null> {
  const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let best: HostWorkStatusState | null = null;
  for (const file of files) {
    if (!file.isFile() || !/^[\da-f]{64}\.json$/.test(file.name)) continue;
    try {
      const handle = await open(join(directory, file.name), 'r');
      const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer).finally(() => handle.close());
      if (bytesRead > MAX_SNAPSHOT_BYTES) continue;
      const entry = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as { state?: unknown; at?: unknown };
      const state = HOST_WORK_STATUS_STATES.find((known) => known === entry.state);
      if (!state) continue;
      const age = typeof entry.at === 'number' ? now - entry.at : Infinity;
      if (!Number.isFinite(age) || age < 0 || age >= (state === 'success' ? COMPLETE_TTL_MS : ACTIVE_TTL_MS)) continue;
      if (best === null || WORK_STATUS_PRIORITY[state] > WORK_STATUS_PRIORITY[best]) best = state;
    } catch {
      // The hook may have removed a snapshot while it was being read.
    }
  }
  return best;
}

/** Poll only in the packaged desktop application and stop when its context is disposed. */
export function subscribeCodexWorkStatus(
  directory: string,
  onChange: (state: HostWorkStatusState | null) => void,
  onPoll?: (state: HostWorkStatusState | null) => void,
): () => void {
  let stopped = false;
  let last: HostWorkStatusState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    const state = await readCodexWorkStatus(directory);
    if (stopped) return;
    if (state !== last) {
      last = state;
      onChange(state);
    }
    onPoll?.(state);
    timer = setTimeout(() => void tick(), 1_000).unref();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
