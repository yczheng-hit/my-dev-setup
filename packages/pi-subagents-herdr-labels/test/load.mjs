// Pi's real extension loader, isolated configuration. No model calls or saved sessions.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to the installed Pi host');
const source = join(process.env.PI_AGENT_HOME ?? join(homedir(), '.pi/agent'), 'npm/node_modules/pi-subagents');
const dir = mkdtempSync(join(tmpdir(), 'herdr-adapter-load-'));
process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete process.env[key];
try {
  mkdirSync(join(dir, 'agent/npm/node_modules'), { recursive: true });
  mkdirSync(join(dir, 'work'));
  symlinkSync(source, join(dir, 'agent/npm/node_modules/pi-subagents'));
  // A project-local npm override must not run before Pi's project-trust gate.
  mkdirSync(join(dir, 'work/.pi/npm/node_modules/pi-subagents'), { recursive: true });
  writeFileSync(join(dir, 'work/.pi/npm/node_modules/pi-subagents/package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  writeFileSync(join(dir, 'work/.pi/npm/node_modules/pi-subagents/index.js'), 'throw new Error("Untrusted project npm override ran");\n');
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(host, 'dist/index.js')));
  const adapter = fileURLToPath(new URL('..', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: join(dir, 'work'), agentDir: join(dir, 'agent'),
    settingsManager: SettingsManager.inMemory({ packages: [{ source: 'npm:pi-subagents', extensions: [] }, adapter] }),
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1, 'upstream factory must be registered exactly once');
  assert.ok(loader.getSkills().skills.some(skill => skill.name === 'pi-subagents'), 'npm skills remain available');
  const extension = result.extensions[0];
  assert.ok(extension.tools.has('subagents_enable'));
  assert.ok(extension.commands.has('run'));
  console.log(`PASS real Pi loader: tools=${extension.tools.size} commands=${extension.commands.size} handlers=${extension.handlers.size}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(0);
