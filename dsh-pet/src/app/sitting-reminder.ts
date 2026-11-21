import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBody } from '../host/http.ts';
import { writePrivateJson } from '../standalone/ai-storage.ts';
import type { RegisteredRoute } from '../standalone/context.ts';
import { sendJson } from '../standalone/server/respond.ts';

const MINUTE_MS = 60_000;
export const SITTING_NOTICE_MS = 10_000;
const DEFAULT_MESSAGE = '该起来活动一下啦！';

interface SittingReminderSettings {
  enabled: boolean;
  intervalMinutes: number;
  message: string;
}

interface SavedReminder extends SittingReminderSettings {
  startedAt: number | null;
}

export interface SittingReminderNotice {
  text: string;
  until: number;
}

const DEFAULTS: SavedReminder = { enabled: false, intervalMinutes: 60, message: DEFAULT_MESSAGE, startedAt: null };

export function parseSittingReminderSettings(raw: unknown): SittingReminderSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const { enabled, intervalMinutes, message } = raw as Partial<SittingReminderSettings>;
  if (typeof enabled !== 'boolean' || typeof message !== 'string' || message.trim().length > 80) return null;
  if (
    typeof intervalMinutes !== 'number' ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 5 ||
    intervalMinutes > 300
  )
    return null;
  return { enabled, intervalMinutes, message: message.trim() || DEFAULT_MESSAGE };
}

function readReminder(file: string, now: () => number): SavedReminder {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 2048) return DEFAULTS;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedReminder>;
    const settings = parseSittingReminderSettings(raw);
    if (!settings) return DEFAULTS;
    const value = raw.startedAt;
    const start = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : now();
    return { ...settings, startedAt: settings.enabled ? start : null };
  } catch {
    return DEFAULTS;
  }
}

interface SittingReminderOptions {
  file: string;
  now?: () => number;
  onNotice?: (notice: SittingReminderNotice | null) => void;
}

/** Track one wall-clock interval for the desktop app, independent of open renderer windows. */
export function createSittingReminder({ file, now = Date.now, onNotice }: SittingReminderOptions) {
  let saved = readReminder(file, now);
  let currentNotice: SittingReminderNotice | null = null;
  const deadline = (): number | null =>
    saved.startedAt === null ? null : saved.startedAt + saved.intervalMinutes * MINUTE_MS;
  const snapshot = () => {
    const { enabled, intervalMinutes, message } = saved;
    return { enabled, intervalMinutes, message, nextAt: deadline() };
  };
  const notice = (): SittingReminderNotice | null =>
    currentNotice && currentNotice.until > now() ? currentNotice : null;

  const commit = (next: SavedReminder): void => {
    mkdirSync(dirname(file), { recursive: true });
    writePrivateJson(file, next);
    saved = next;
  };

  const configure = (settings: SittingReminderSettings) => {
    if (
      settings.enabled === saved.enabled &&
      settings.intervalMinutes === saved.intervalMinutes &&
      settings.message === saved.message
    )
      return snapshot();
    commit({ ...settings, startedAt: settings.enabled ? (saved.startedAt ?? now()) : null });
    if (!settings.enabled && currentNotice) {
      currentNotice = null;
      onNotice?.(null);
    }
    return snapshot();
  };

  const tick = (canNotify = true): void => {
    const time = now();
    const nextAt = deadline();
    if (!canNotify || nextAt === null || time < nextAt) return;
    // After suspension, emit one reminder and start a full interval from this actual notification.
    commit({ ...saved, startedAt: time });
    currentNotice = { text: saved.message, until: time + SITTING_NOTICE_MS };
    onNotice?.(currentNotice);
  };

  return { configure, snapshot, tick, notice };
}

export function sittingReminderRoute(timer: ReturnType<typeof createSittingReminder>): RegisteredRoute {
  return {
    kind: 'exact',
    path: '/standalone-ai/sitting-reminder',
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, timer.snapshot());
        return;
      }
      if (req.method !== 'PUT') {
        res.setHeader('allow', 'GET, PUT');
        sendJson(res, 405, { error: '仅支持读取和保存久坐提醒设置。' });
        return;
      }
      const body = await readBody(req);
      let settings: SittingReminderSettings | null = null;
      try {
        settings = parseSittingReminderSettings(JSON.parse(body));
      } catch {
        // Malformed JSON uses the same form feedback as invalid settings.
      }
      if (!settings) {
        sendJson(res, 400, { error: '提醒间隔须为 5–300 的整数分钟，提示语最多 80 字。' });
        return;
      }
      sendJson(res, 200, timer.configure(settings));
    },
  };
}
