import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBody } from '../host/http.ts';
import { writePrivateJson } from '../standalone/ai-storage.ts';
import type { RegisteredRoute } from '../standalone/context.ts';
import { sendJson } from '../standalone/server/respond.ts';

const MINUTE_MS = 60_000;

interface IntervalReminderSettings {
  enabled: boolean;
  intervalMinutes: number;
  message: string;
}

interface SavedReminder extends IntervalReminderSettings {
  startedAt: number | null;
  waitingSince: number | null;
}

export interface IntervalReminderNotice {
  text: string;
  id: number;
}

export function parseIntervalReminderSettings(raw: unknown, defaultMessage: string): IntervalReminderSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const { enabled, intervalMinutes, message } = raw as Partial<IntervalReminderSettings>;
  if (typeof enabled !== 'boolean' || typeof message !== 'string' || message.trim().length > 80) return null;
  if (
    typeof intervalMinutes !== 'number' ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 5 ||
    intervalMinutes > 300
  )
    return null;
  return { enabled, intervalMinutes, message: message.trim() || defaultMessage };
}

function readReminder(file: string, defaults: SavedReminder, now: () => number): SavedReminder {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 2048) return defaults;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedReminder>;
    const settings = parseIntervalReminderSettings(raw, defaults.message);
    if (!settings) return defaults;
    const value = raw.startedAt;
    const start = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : now();
    const waiting = raw.waitingSince;
    return {
      ...settings,
      startedAt: settings.enabled ? start : null,
      waitingSince:
        settings.enabled && typeof waiting === 'number' && Number.isSafeInteger(waiting) && waiting >= 0
          ? waiting
          : null,
    };
  } catch {
    return defaults;
  }
}

interface IntervalReminderOptions {
  file: string;
  defaultMessage: string;
  now?: () => number;
  onNotice?: (notice: IntervalReminderNotice | null, announced?: boolean) => void;
}

/** Track one wall-clock interval for the desktop app, independent of open renderer windows. */
export function createIntervalReminder({ file, defaultMessage, now = Date.now, onNotice }: IntervalReminderOptions) {
  let saved = readReminder(
    file,
    { enabled: false, intervalMinutes: 60, message: defaultMessage, startedAt: null, waitingSince: null },
    now,
  );
  const deadline = (): number | null =>
    saved.startedAt === null || saved.waitingSince !== null
      ? null
      : saved.startedAt + saved.intervalMinutes * MINUTE_MS;
  const snapshot = () => {
    const { enabled, intervalMinutes, message, waitingSince } = saved;
    return { enabled, intervalMinutes, message, nextAt: deadline(), waiting: waitingSince !== null };
  };
  const notice = (): IntervalReminderNotice | null =>
    saved.waitingSince === null ? null : { text: saved.message, id: saved.waitingSince };

  const commit = (next: SavedReminder): void => {
    mkdirSync(dirname(file), { recursive: true });
    writePrivateJson(file, next);
    saved = next;
  };

  const configure = (settings: IntervalReminderSettings) => {
    if (
      settings.enabled === saved.enabled &&
      settings.intervalMinutes === saved.intervalMinutes &&
      settings.message === saved.message
    )
      return snapshot();
    const wasWaiting = saved.waitingSince !== null;
    commit({
      ...settings,
      startedAt: settings.enabled ? (saved.startedAt ?? now()) : null,
      waitingSince: settings.enabled ? saved.waitingSince : null,
    });
    if (wasWaiting) onNotice?.(notice());
    return snapshot();
  };

  const tick = (canNotify = true): boolean => {
    const time = now();
    const nextAt = deadline();
    if (!canNotify || nextAt === null || time < nextAt) return false;
    commit({ ...saved, waitingSince: time });
    onNotice?.(notice(), true);
    return true;
  };

  const acknowledge = (id: unknown, clickedAt = now()): boolean => {
    if (saved.waitingSince === null || saved.waitingSince !== id) return false;
    commit({ ...saved, startedAt: clickedAt, waitingSince: null });
    onNotice?.(null);
    return true;
  };

  return { configure, snapshot, tick, notice, acknowledge };
}

export function intervalReminderRoute(
  timer: ReturnType<typeof createIntervalReminder>,
  route: string,
  defaultMessage: string,
): RegisteredRoute {
  return {
    kind: 'exact',
    path: '/standalone-ai/' + route,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, timer.snapshot());
        return;
      }
      if (req.method !== 'PUT') {
        res.setHeader('allow', 'GET, PUT');
        sendJson(res, 405, { error: '仅支持读取和保存提醒设置。' });
        return;
      }
      const body = await readBody(req);
      let settings: IntervalReminderSettings | null = null;
      try {
        settings = parseIntervalReminderSettings(JSON.parse(body), defaultMessage);
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
