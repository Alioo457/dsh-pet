import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface, type ReadLineOptions } from 'node:readline';
import { promisify } from 'node:util';

const REFRESH_MS = 60_000;
const TIMEOUT_MS = 10_000;
const run = promisify(execFile);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function formatCodexQuota(payload: unknown): string {
  const result = record(payload);
  const fallback = record(result?.rateLimits);
  const bucket =
    record(record(result?.rateLimitsByLimitId)?.codex) ??
    (fallback?.limitId == null || fallback?.limitId === 'codex' ? fallback : undefined);
  const windows = [record(bucket?.primary), record(bucket?.secondary)];
  const remaining = (minutes: number): string => {
    const used = windows.find((item) => item?.windowDurationMins === minutes)?.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used)) return '—';
    return Math.floor(100 - Math.min(100, Math.max(0, used))) + '%';
  };
  return `周限：${remaining(10080)}；5H：${remaining(300)}`;
}

/** Resolve the Windows Desktop installation or a native CLI binary without invoking a command shim. */
async function findCodex(signal: AbortSignal): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => dir.replace(/^"|"$/g, ''))
    .filter(isAbsolute);
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const npmDirs = [...dirs, join(process.env.APPDATA ?? '', 'npm')].filter(isAbsolute);
  const candidates = [
    ...dirs.map((dir) => join(dir, 'codex.exe')),
    ...npmDirs.map((dir) =>
      join(
        dir,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-' + architecture,
        'vendor',
        target,
        'bin',
        'codex.exe',
      ),
    ),
  ];
  for (const path of new Set(candidates)) {
    if (signal.aborted) return undefined;
    if ((await stat(path).catch(() => null))?.isFile()) return path;
  }
  try {
    const shell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const { stdout } = await run(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation",
      ],
      { windowsHide: true, timeout: 5000, signal, maxBuffer: 8192 },
    );
    const root = stdout.trim();
    if (!isAbsolute(root)) return undefined;
    const binary = join(root, 'app', 'resources', 'codex.exe');
    return (await stat(binary)).isFile() ? binary : undefined;
  } catch {
    return undefined;
  }
}

/** Query only the documented read-only account method. Credentials remain owned by Codex. */
export function readCodexQuota(executable: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // The project's ambient Node types disagree on the async iterator of this readable pipe.
    const input = child.stdout as unknown as ReadLineOptions['input'];
    const output = createInterface({ input, crlfDelay: Infinity });
    let finished = false;
    const finish = (result: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      output.close();
      child.stdin.end();
      child.kill();
      resolve(result);
    };
    const abort = (): void => finish(null);
    const timeout = setTimeout(abort, TIMEOUT_MS).unref();
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', abort);
    child.stdin.on('error', abort);
    child.once('close', abort);
    const send = (value: object): void => {
      child.stdin.write(JSON.stringify(value) + '\n');
    };
    output.on('line', (line) => {
      let response;
      try {
        response = record(JSON.parse(line));
      } catch {
        return;
      }
      if (response?.id === 1) {
        if (response.error) {
          finish(null);
          return;
        }
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (response?.id === 2) {
        finish(response.result ?? null);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'dsh-pet', version: '1', title: 'dsh-pet' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
  });
}

/** Refresh while Codex is active. The desktop status poll calls refresh without waiting for the subprocess. */
export function createCodexQuotaMonitor(
  onChange: (line: string) => void,
  read?: (signal: AbortSignal) => Promise<unknown>,
  now = Date.now,
) {
  let executable: string | undefined;
  const query =
    read ??
    (async (signal: AbortSignal) => {
      executable ??= await findCodex(signal);
      if (!executable) return null;
      const result = await readCodexQuota(executable, signal);
      if (!result) executable = undefined;
      return result;
    });
  const controller = new AbortController();
  let line = formatCodexQuota(null);
  let nextRead = -Infinity;
  let pending = false;
  const refresh = (): void => {
    const { signal } = controller;
    const time = now();
    if (signal.aborted || pending || time < nextRead) return;
    pending = true;
    nextRead = time + REFRESH_MS;
    void query(signal)
      .catch(() => null)
      .then((result) => {
        pending = false;
        const next = formatCodexQuota(result);
        if (signal.aborted || next === line) return;
        line = next;
        onChange(next);
      });
  };
  return { refresh, currentLine: () => line, stop: () => controller.abort() };
}
