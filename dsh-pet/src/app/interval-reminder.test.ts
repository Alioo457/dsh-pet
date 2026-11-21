import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createIntervalReminder,
  parseIntervalReminderSettings,
  type IntervalReminderNotice,
} from './interval-reminder.ts';

const minute = 60_000;
const settings = { enabled: true, intervalMinutes: 5, message: '起来活动一下' };
const defaultMessage = '该起来活动一下啦！';

test('启用后的第一轮从完整间隔开始，重启保留计时起点', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sitting-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sitting-reminder.json');
  let now = minute;
  const start = now;
  const events: IntervalReminderNotice[] = [];
  const create = () =>
    createIntervalReminder({
      file,
      defaultMessage,
      now: () => now,
      onNotice: (notice) => {
        if (notice) events.push(notice);
      },
    });
  let timer = create();
  assert.equal(timer.snapshot().enabled, false);
  assert.equal(timer.snapshot().intervalMinutes, 60);
  timer.tick();
  assert.equal(events.length, 0);
  assert.equal(timer.configure(settings).nextAt, start + 5 * minute);

  now += 4 * minute;
  timer = create();
  assert.equal(timer.snapshot().nextAt, start + 5 * minute);
  timer.tick();
  assert.equal(events.length, 0);
  timer.configure({ ...settings, message: '离开椅子活动一下' });
  assert.equal(timer.snapshot().nextAt, start + 5 * minute);
  now += minute;
  timer.tick();
  assert.equal(events[0]?.text, '离开椅子活动一下');
  assert.equal(timer.snapshot().nextAt, now + 5 * minute);
});

test('逾期只补一次提示，暂缓期间保留到期提醒，停用立即取消', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sitting-defer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sitting-reminder.json');
  let now = 10 * minute;
  let notices = 0;
  const make = () =>
    createIntervalReminder({
      file,
      defaultMessage,
      now: () => now,
      onNotice: (notice) => {
        if (notice) notices += 1;
      },
    });
  const before = make();
  const nextAt = before.configure(settings).nextAt;
  now += 90 * minute;
  const restored = make();
  restored.tick(false);
  assert.equal(notices, 0);
  assert.equal(restored.snapshot().nextAt, nextAt);
  restored.tick();
  restored.tick();
  assert.equal(notices, 1);
  assert.ok(restored.notice());
  restored.configure({ ...settings, enabled: false });
  assert.equal(restored.notice(), null);
  assert.equal(restored.snapshot().nextAt, null);
  now += 90 * minute;
  make().tick();
  assert.equal(notices, 1);
});

test('接受合法间隔和提示语，拒绝范围外和超长输入', () => {
  assert.deepEqual(parseIntervalReminderSettings(settings, defaultMessage), settings);
  assert.equal(parseIntervalReminderSettings({ ...settings, message: '  ' }, defaultMessage)?.message, defaultMessage);
  assert.equal(parseIntervalReminderSettings({ ...settings, intervalMinutes: 4 }, defaultMessage), null);
  assert.equal(parseIntervalReminderSettings({ ...settings, intervalMinutes: 301 }, defaultMessage), null);
  assert.equal(parseIntervalReminderSettings({ ...settings, message: '字'.repeat(81) }, defaultMessage), null);
});

test('喝水与久坐可以独立启停并持久化自己的时长和提示', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-reminders-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const sitting = createIntervalReminder({ file: join(directory, 'sitting.json'), defaultMessage, now: () => now });
  const waterOptions = {
    file: join(directory, 'water.json'),
    defaultMessage: '该喝水啦！',
    now: () => now,
  };
  const water = createIntervalReminder(waterOptions);
  assert.equal(water.snapshot().message, waterOptions.defaultMessage);
  sitting.configure(settings);
  assert.equal(water.snapshot().enabled, false);
  water.configure({ enabled: true, intervalMinutes: 10, message: '喝杯水' });
  now += 5 * minute;
  sitting.tick();
  water.tick();
  assert.equal(water.notice(), null);
  sitting.configure({ ...settings, enabled: false });
  assert.equal(water.snapshot().enabled, true);
  const restored = createIntervalReminder(waterOptions);
  assert.deepEqual(restored.snapshot(), water.snapshot());
  now += 5 * minute;
  restored.tick();
  assert.equal(restored.notice()?.text, '喝杯水');
  assert.equal(sitting.notice(), null);
});
