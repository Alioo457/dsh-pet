/** 久坐提醒设置。只在独立桌面端进入该标签时读取。 */
export function sittingReminderScript(): string {
  return `
let loadSittingReminderPanel = null;

function activateSittingReminder() {
  if (!loadSittingReminderPanel) loadSittingReminderPanel = mountSittingReminder();
  loadSittingReminderPanel?.();
}

function mountSittingReminder() {
  const form = byId('sitting-reminder-form');
  if (!form) return;
  const enabled = byId('sitting-reminder-enabled');
  const interval = byId('sitting-reminder-interval');
  const message = byId('sitting-reminder-message');
  const save = byId('sitting-reminder-save');
  const status = byId('sitting-reminder-status');
  const endpoint = '/standalone-ai/sitting-reminder';
  let loaded = false;
  let busy = false;

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
      setStatus(status, method === 'GET' ? '' : model.enabled ? '久坐提醒已启用。' : '久坐提醒已关闭。', 'ok');
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      busy = false;
      for (const input of [enabled, interval, message, save]) input.disabled = !loaded;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!loaded) return;
    void request('PUT', {
      enabled: enabled.checked,
      intervalMinutes: Number(interval.value),
      message: message.value,
    });
  });
  return () => void request('GET');
}
`;
}
