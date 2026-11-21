/** 桌面设置页的番茄钟控制。截止时间由应用主进程维护。 */
export function pomodoroScript(): string {
  return `
let loadPomodoroPanel = null;

function activatePomodoro() {
  if (!loadPomodoroPanel) loadPomodoroPanel = mountPomodoro();
  loadPomodoroPanel?.();
}

function mountPomodoro() {
  const panel = byId('panel-pomodoro');
  if (!panel) return;
  const focus = byId('pomodoro-focus');
  const rest = byId('pomodoro-break');
  const start = byId('pomodoro-start');
  const stop = byId('pomodoro-stop');
  const save = byId('pomodoro-save');
  const countdown = byId('pomodoro-countdown');
  const status = byId('pomodoro-status');
  const endpoint = '/standalone-ai/pomodoro';
  let model = null;
  let busy = false;

  function render() {
    const running = !!(model && model.phase);
    start.hidden = running;
    stop.hidden = !running;
    for (const control of [focus, rest, start, stop, save]) control.disabled = busy || !model;
    if (!running) {
      countdown.textContent = model ? '计时已停止' : '';
      return;
    }
    const seconds = Math.max(0, Math.ceil((model.endsAt - Date.now()) / 1000));
    countdown.textContent =
      (model.phase === 'focus' ? '专注中 ' : '休息中 ') +
      String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }

  async function load(fill) {
    if (busy) return;
    busy = true;
    try {
      model = await callApi('GET', endpoint, undefined, '');
      if (fill) {
        focus.value = String(model.focusMinutes);
        rest.value = String(model.breakMinutes);
        setStatus(status, '');
      }
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  async function update(action) {
    if (busy || !model) return;
    if (action !== 'stop' && (!focus.reportValidity() || !rest.reportValidity() || !focus.value || !rest.value)) {
      setStatus(status, '请填写范围内的整数分钟。', 'error');
      return;
    }
    busy = true;
    render();
    const settings = action === 'stop'
      ? { action }
      : { action, focusMinutes: Number(focus.value), breakMinutes: Number(rest.value) };
    try {
      model = await callApi('PUT', endpoint, settings, '');
      focus.value = String(model.focusMinutes);
      rest.value = String(model.breakMinutes);
      setStatus(status, action === 'stop' ? '已停止计时。' : '番茄钟设置已保存。');
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  start.addEventListener('click', () => void update('start'));
  stop.addEventListener('click', () => void update('stop'));
  save.addEventListener('click', () => void update('save'));
  window.setInterval(() => {
    if (panel.hidden || busy || !model?.phase) return;
    if (model.endsAt <= Date.now()) void load(false);
    else render();
  }, 1000);
  return () => void load(true);
}
`;
}
