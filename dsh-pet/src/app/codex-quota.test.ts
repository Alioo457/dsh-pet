import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexQuotaMonitor, formatCodexQuota } from './codex-quota.ts';

test('按 Codex 主额度桶的真实窗口时长换算剩余百分比', () => {
  assert.equal(
    formatCodexQuota({
      rateLimitsByLimitId: {
        codex: {
          primary: { windowDurationMins: 10080, usedPercent: 80 },
          secondary: { windowDurationMins: 300, usedPercent: 85 },
        },
        codex_other: { primary: { windowDurationMins: 300, usedPercent: 12 } },
      },
      rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1 } },
    }),
    '周限：20%；5H：15%',
  );
  assert.equal(
    formatCodexQuota({
      rateLimits: {
        primary: { windowDurationMins: 300, usedPercent: 101 },
        secondary: { windowDurationMins: 1440, usedPercent: 20 },
      },
    }),
    '周限：—；5H：0%',
  );
  assert.equal(
    formatCodexQuota({ rateLimits: { limitId: 'other', primary: { windowDurationMins: 300, usedPercent: 4 } } }),
    '周限：—；5H：—',
  );
  assert.equal(formatCodexQuota(null), '周限：—；5H：—');
});

test('额度读取合并并发、按分钟限频，并在退出时停止', async () => {
  let now = 0;
  let reads = 0;
  let runningSignal: AbortSignal | undefined;
  const seen: string[] = [];
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const monitor = createCodexQuotaMonitor(
    (line) => seen.push(line),
    async (signal) => {
      reads++;
      runningSignal = signal;
      return reads === 1 ? { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 5 } } } : null;
    },
    () => now,
  );
  assert.equal(monitor.currentLine(), '周限：—；5H：—');
  monitor.refresh();
  monitor.refresh();
  await settle();
  assert.deepEqual(seen, ['周限：—；5H：95%']);
  now = 59_999;
  monitor.refresh();
  assert.equal(reads, 1);
  now += 1;
  monitor.refresh();
  await settle();
  assert.deepEqual(seen, ['周限：—；5H：95%', '周限：—；5H：—']);
  monitor.stop();
  assert.equal(runningSignal?.aborted, true);
  now += 60_000;
  monitor.refresh();
  assert.equal(reads, 2);
});
