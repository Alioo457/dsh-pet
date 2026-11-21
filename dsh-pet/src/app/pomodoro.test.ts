import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPomodoro, parsePomodoroSettings, type PomodoroView } from './pomodoro.ts';

const minute = 60_000;

test('番茄钟默认停止，手动开始后交替专注和休息并保存准确的截止时间', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pomodoro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pomodoro.json');
  let now = 10 * minute;
  const updates: PomodoroView[] = [];
  let timer = createPomodoro({ file, now: () => now, onChange: (view) => updates.push(view) });

  assert.deepEqual(timer.snapshot(), { focusMinutes: 25, breakMinutes: 5, phase: null, endsAt: null });
  timer.tick();
  assert.equal(updates.length, 0);
  const settings = { enabled: true, focusMinutes: 2, breakMinutes: 1 };
  const started = timer.configure(settings);
  assert.equal(started.phase, 'focus');
  assert.equal(started.endsAt, now + 2 * minute);
  now += minute;
  timer = createPomodoro({ file, now: () => now, onChange: (view) => updates.push(view) });
  assert.deepEqual(timer.snapshot(), started);
  assert.deepEqual(timer.configure(settings), started, '重新保存相同时长不重置');

  now = started.endsAt!;
  timer.tick();
  assert.equal(timer.snapshot().phase, 'break');
  assert.equal(timer.snapshot().endsAt, now + minute);
  assert.equal(updates[updates.length - 1]?.notice?.text, '专注结束，休息一下吧。');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).phase, 'break');
  now += 8 * minute;
  timer.tick();
  assert.equal(timer.snapshot().phase, 'focus');
  assert.equal(timer.snapshot().endsAt, now + 2 * minute, '唤醒只进入下一阶段一次');
  assert.equal(updates[updates.length - 1]?.notice?.text, '休息结束，开始下一轮专注。');
  timer.configure({ ...settings, enabled: false });
  assert.equal(timer.snapshot().phase, null);
  assert.equal(timer.snapshot().notice, undefined);
  assert.equal(createPomodoro({ file }).snapshot().endsAt, null);
});

test('修改时长从下一阶段生效，损坏配置可以重新保存', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pomodoro-recover-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pomodoro.json');
  writeFileSync(file, 'invalid');
  let now = 1;
  const timer = createPomodoro({ file, now: () => now });
  const started = timer.configure({ enabled: true, focusMinutes: 5, breakMinutes: 2 });
  timer.configure({ enabled: true, focusMinutes: 3, breakMinutes: 4 });
  assert.equal(timer.snapshot().endsAt, started.endsAt);
  now = started.endsAt!;
  timer.tick();
  assert.equal(timer.snapshot().endsAt, now + 4 * minute);
});

test('设置只接受合法的开关和范围内的整数分钟', () => {
  const valid = { enabled: true, focusMinutes: 120, breakMinutes: 1 };
  assert.deepEqual(parsePomodoroSettings(valid), valid);
  for (const value of [
    null,
    { ...valid, enabled: 'true' },
    { ...valid, focusMinutes: 0 },
    { ...valid, focusMinutes: 2.5 },
    { ...valid, breakMinutes: 61 },
  ]) {
    assert.equal(parsePomodoroSettings(value), null);
  }
});

test('Windows 托盘初始化后补发仍有效的阶段提示', { skip: process.platform !== 'win32' }, async (t) => {
  const { createTray } = createRequire(import.meta.url)('../../runtime/electron-helper/main/tray.js');
  const balloons: Array<{ title: string; content: string }> = [];
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  class Tray {
    setToolTip() {}
    setContextMenu() {}
    displayBalloon(balloon: { title: string; content: string }) {
      balloons.push(balloon);
    }
  }
  const icon = { isEmpty: () => false, resize: () => icon };
  const deps = {
    Tray,
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => icon },
    hostRequest: async () => ({ body: JSON.stringify({ main: { pets: [{ id: 'main', display: 'desktop' }] } }) }),
    appMode: true,
    helperDir: 'unused',
    platform: {},
  };
  const tray = createTray(deps);
  tray.showBalloon('番茄钟', '阶段已切换', time + 10_000);
  assert.deepEqual(balloons, []);
  await tray.start();
  assert.deepEqual(
    balloons.map(({ content }) => content),
    ['阶段已切换'],
  );

  const expired = createTray(deps);
  expired.showBalloon('番茄钟', '过期的旧通知', time + 10_000);
  time += 10_000;
  await expired.start();
  assert.equal(balloons.length, 1);
});
