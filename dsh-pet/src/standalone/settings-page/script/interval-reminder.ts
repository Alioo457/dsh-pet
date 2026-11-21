/** 定时提醒设置。只在独立桌面端进入对应标签时读取。 */
export function intervalReminderScript(): string {
  return `
const intervalReminderPanels = new Map();

function activateIntervalReminder(id) {
  if (!intervalReminderPanels.has(id)) intervalReminderPanels.set(id, mountIntervalReminder(id));
  intervalReminderPanels.get(id)?.();
}

function mountIntervalReminder(id) {
  const form = byId(id + '-form');
  if (!form) return;
  const enabled = byId(id + '-enabled');
  const interval = byId(id + '-interval');
  const message = byId(id + '-message');
  const save = byId(id + '-save');
  const status = byId(id + '-status');
  const title = byId('tab-' + id).dataset.title;
  const endpoint = '/standalone-ai/' + id;
  let loaded = false;
  let busy = false;
  let dirty = false;

  async function request(method, settings) {
    if (busy) return;
    busy = true;
    for (const input of [enabled, interval, message, save]) input.disabled = true;
    try {
      const model = await callApi(method, endpoint, settings, '');
      enabled.checked = model.enabled;
      interval.value = String(model.intervalMinutes);
      message.value = model.message;
      loaded = true;
      dirty = false;
      setStatus(status, method === 'GET' ? '' : title + (model.enabled ? '已启用。' : '已关闭。'), 'ok');
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      busy = false;
      for (const input of [enabled, interval, message, save]) input.disabled = !loaded;
    }
  }

  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!loaded) return;
    void request('PUT', {
      enabled: enabled.checked,
      intervalMinutes: Number(interval.value),
      message: message.value,
    });
  });
  return () => { if (!dirty) void request('GET'); };
}
`;
}
