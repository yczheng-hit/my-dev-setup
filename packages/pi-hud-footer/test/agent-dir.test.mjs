import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR');
const require = createRequire(path.join(host, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false });
const { HUD_CURRENCIES, HUD_DISPLAY_KEYS, HUD_DISPLAY_SCOPES } = await jiti.import('../extensions/hud-footer/types.ts');
const source = stripTypeScriptTypes(readFileSync(new URL('../extensions/hud-footer/config.ts', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from [^;]+;\s*$/gm, '').replace(/^export /gm, '');

test('global HUD config follows the native custom agent directory, never writes real user config', () => {
  const files = new Map();
  const fakeHome = '/fixture/home';
  const agentDir = '/fixture/custom-agent';
  const sandbox = { CONFIG_DIR_NAME: '.pi', getAgentDir: () => agentDir,
    homedir: () => fakeHome, dirname: path.dirname, join: path.join, console,
    HUD_CURRENCIES, HUD_DISPLAY_KEYS, HUD_DISPLAY_SCOPES,
    normalizeLanguageSetting: (value) => value,
    mkdirSync() {}, existsSync: (file) => files.has(file),
    readFileSync: (file) => files.get(file), writeFileSync: (file, text) => files.set(file, text),
  };
  vm.runInNewContext(source + '\nthis.functions = {loadConfig, saveConfig};', sandbox);
  const ctx = { cwd: '/fixture/project', isProjectTrusted: () => false };
  const actual = sandbox.functions.saveConfig(ctx, { style: 'border', language: 'zh' });
  assert.equal(actual, path.join(agentDir, 'hud-footer.json'));
  assert.equal(files.size, 1);
  assert.equal(sandbox.functions.loadConfig(ctx).language, 'zh');
});
