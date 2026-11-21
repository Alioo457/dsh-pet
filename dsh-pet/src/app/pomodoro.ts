import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBody } from '../host/http.ts';
import { writePrivateJson } from '../standalone/ai-storage.ts';
import type { RegisteredRoute } from '../standalone/context.ts';
import { sendJson } from '../standalone/server/respond.ts';

type Phase = 'focus' | 'break';
type Cycle = { phase: Phase; endsAt: number } | { phase: null; endsAt: null };

export interface PomodoroSettings {
  enabled: boolean;
  focusMinutes: number;
  breakMinutes: number;
}

type SavedPomodoro = Omit<PomodoroSettings, 'enabled'> & Cycle;
export type PomodoroView = SavedPomodoro & { notice?: { text: string; until: number } };

const MINUTE_MS = 60_000;
const NOTICE_MS = 10_000;
const DEFAULTS: SavedPomodoro = { focusMinutes: 25, breakMinutes: 5, phase: null, endsAt: null };

export function parsePomodoroSettings(raw: unknown): PomodoroSettings | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { enabled, focusMinutes, breakMinutes } = raw as Partial<PomodoroSettings>;
  if (typeof enabled !== 'boolean') return null;
  if (typeof focusMinutes !== 'number' || !Number.isInteger(focusMinutes) || focusMinutes < 1 || focusMinutes > 120)
    return null;
  if (typeof breakMinutes !== 'number' || !Number.isInteger(breakMinutes) || breakMinutes < 1 || breakMinutes > 60)
    return null;
  return { enabled, focusMinutes, breakMinutes };
}

function readPomodoro(file: string): SavedPomodoro {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 2048) return DEFAULTS;
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedPomodoro>;
    const settings = parsePomodoroSettings({ ...saved, enabled: false });
    if (!settings) return DEFAULTS;
    const { focusMinutes, breakMinutes } = settings;
    const { phase, endsAt } = saved;
    if ((phase === 'focus' || phase === 'break') && typeof endsAt === 'number' && Number.isSafeInteger(endsAt))
      return { focusMinutes, breakMinutes, phase, endsAt };
    return { focusMinutes, breakMinutes, phase: null, endsAt: null };
  } catch {
    // A missing or unreadable file leaves the optional timer stopped.
    return DEFAULTS;
  }
}

interface PomodoroOptions {
  file: string;
  now?: () => number;
  onChange?: (view: PomodoroView, announcement?: string) => void;
}

/** The app process owns one cycle. Renderer reloads do not affect deadlines. */
export function createPomodoro({ file, now = Date.now, onChange }: PomodoroOptions) {
  let saved = readPomodoro(file);
  let notice: PomodoroView['notice'];

  const snapshot = (): PomodoroView => (notice && notice.until > now() ? { ...saved, notice } : { ...saved });
  const commit = (next: SavedPomodoro): void => {
    mkdirSync(dirname(file), { recursive: true });
    writePrivateJson(file, next);
    saved = next;
  };

  const configure = ({ enabled, focusMinutes, breakMinutes }: PomodoroSettings): PomodoroView => {
    const active = saved.phase !== null;
    if (active === enabled && saved.focusMinutes === focusMinutes && saved.breakMinutes === breakMinutes)
      return snapshot();
    const cycle: Cycle = !enabled
      ? { phase: null, endsAt: null }
      : saved.phase === null
        ? { phase: 'focus', endsAt: now() + focusMinutes * MINUTE_MS }
        : { phase: saved.phase, endsAt: saved.endsAt };
    commit({ focusMinutes, breakMinutes, ...cycle });
    if (!enabled) notice = undefined;
    const view = snapshot();
    onChange?.(view);
    return view;
  };

  const tick = (): void => {
    const time = now();
    if (saved.phase === null || time < saved.endsAt) return;
    const phase = saved.phase === 'focus' ? 'break' : 'focus';
    const minutes = phase === 'focus' ? saved.focusMinutes : saved.breakMinutes;
    const text = phase === 'break' ? '专注结束，休息一下吧。' : '休息结束，开始下一轮专注。';
    commit({ ...saved, phase, endsAt: time + minutes * MINUTE_MS });
    notice = { text, until: time + NOTICE_MS };
    onChange?.(snapshot(), text);
  };

  return { configure, snapshot, tick };
}

/** Settings use the same loopback authorization and bounded body handling as the app's other routes. */
export function pomodoroRoute(timer: ReturnType<typeof createPomodoro>): RegisteredRoute {
  return {
    kind: 'exact',
    path: '/standalone-ai/pomodoro',
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, timer.snapshot());
        return;
      }
      if (req.method !== 'PUT') {
        res.setHeader('allow', 'GET, PUT');
        sendJson(res, 405, { error: '仅支持读取和保存番茄钟设置。' });
        return;
      }
      const body = await readBody(req);
      let settings: PomodoroSettings | null = null;
      try {
        const command = JSON.parse(body);
        const current = timer.snapshot();
        if (command?.action === 'stop') {
          settings = { enabled: false, focusMinutes: current.focusMinutes, breakMinutes: current.breakMinutes };
        } else if (command?.action === 'save' || command?.action === 'start') {
          // Apply only the requested operation, using live state instead of the settings tab's snapshot.
          settings = parsePomodoroSettings({
            ...command,
            enabled: command.action === 'start' || current.phase !== null,
          });
        }
      } catch {
        // Invalid JSON and out-of-range settings use the same form feedback.
      }
      if (!settings) {
        sendJson(res, 400, { error: '番茄钟设置无效。专注时长为 1–120 分钟，休息时长为 1–60 分钟。' });
        return;
      }
      sendJson(res, 200, timer.configure(settings));
    },
  };
}
