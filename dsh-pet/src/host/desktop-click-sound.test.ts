import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const helper = new URL('../../runtime/electron-helper/', import.meta.url);
const source = (file: string): string => readFileSync(new URL(file, helper), 'utf8');

for (const sleeping of [false, true]) {
  test(`desktop clicks stay silent with legacy sound enabled (sleeping=${sleeping})`, () => {
    let audioCreated = false;
    const actions: string[] = [];
    runInNewContext(
      source('sprite.js') +
        source('sprite/input.js') +
        `
PetSprite.prototype.onClick.call({
  sleeping,
  dragState: {},
  animations: { clicks: ['tap'] },
  stopThrow() {},
  stopMove() {},
  playOnce(name) { actions.push(name); },
  postSleepAction(action) { actions.push(action); },
}, {});
`,
      {
        BASE: 'http://127.0.0.1:3080/dsh-pet-7340',
        config: { clickSoundEnabled: true },
        navigator: { platform: 'Win32' },
        S: { pick: (items: string[]) => items[0] },
        Audio: class {
          constructor() {
            audioCreated = true;
          }
        },
        sleeping,
        actions,
      },
    );
    assert.equal(audioCreated, false);
    assert.deepEqual(actions, [sleeping ? 'wake' : 'tap']);
  });
}

test('desktop reminders use the fixed voice and playback volume despite legacy settings', async () => {
  const configured: unknown[][] = [];
  const boot = runInNewContext(source('renderer.js').replace(/void boot\(\);\s*$/, 'boot();'), {
    BASE: 'http://127.0.0.1:3080/dsh-pet-7340',
    S: {
      flattenConfigPets: () => [],
      DEFAULT_FONT: { family: 'system' },
      fontStackOf: () => 'system',
      setVoiceBase() {},
      setSurface() {},
      setVoiceConfig: (...values: unknown[]) => configured.push(values),
    },
    config: null,
    window: { __dshPetDebug: {}, addEventListener() {}, close() {} },
    document: {
      createElement: () => ({}),
      head: { appendChild() {} },
      documentElement: { style: { setProperty() {} } },
    },
    errorEl: { classList: { remove() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ main: { voiceName: 'legacy/voice', voiceVolume: 0.15 } }) }),
  }) as Promise<void>;
  await boot;
  assert.deepEqual(configured, [['edge/zh-CN-XiaoyiNeural', 1]]);
});
