#!/usr/bin/env node
// Runs before a fresh Pi starts, never from a live extension runtime.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLaunchHook, queueRoot } from './maintenance-queue.mjs';
import { fileURLToPath } from 'node:url';
export function isSessionLaunch(args) {
  const commands = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);
  return !args.some(arg => ['--version', '-v', '--help', '-h', '--export', '--list-models'].includes(arg)) && !commands.has(args[0]);
}
export function launch(metadataFile, args) {
  const bin = metadataFile.replace(/\.my-dev-setup\.json$/, '');
  const hook = readLaunchHook(bin);
  if (!hook || `${bin}.my-dev-setup.json` !== metadataFile) throw new Error('Pi maintenance launcher ownership cannot be verified.');
  const env = { ...process.env, PATH: `${path.dirname(hook.original.node)}${path.delimiter}${process.env.PATH ?? ''}` };
  const pending = path.join(queueRoot(hook.agentDir), 'pending.json');
  if (isSessionLaunch(args)) {
    const root = queueRoot(hook.agentDir); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const guard = path.join(root, 'startup.lock');
    let descriptor;
    try { descriptor = fs.openSync(guard, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Another Pi startup is activating maintenance. Try starting Pi again once it finishes.'); throw error; }
    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      if (fs.existsSync(pending)) {
        const statusFile = path.join(root, 'status.json');
        if (fs.existsSync(statusFile) && JSON.parse(fs.readFileSync(statusFile, 'utf8')).status === 'failed') throw new Error('Previous activation failed after installation started. Ask the agent to inspect the backup/status before starting another session.');
        const result = spawnSync(hook.original.node, [path.join(hook.repo, 'scripts/maintain.mjs'), 'activate', '--repo', hook.repo, '--agent-dir', hook.agentDir],
          { env: { ...env, PI_MAINTENANCE_LAUNCH_PID: String(process.pid) }, stdio: 'inherit', timeout: 30 * 60 * 1000 });
        // Failure may leave a partly installed host; do not silently start a mixed runtime.
        if (result.error || result.status !== 0) throw new Error('Pending maintenance could not activate safely. Ask the Pi agent to inspect maintenance status; no session was started.');
      }
    } finally { fs.closeSync(descriptor); fs.unlinkSync(guard); }
  }
  const current = readLaunchHook(bin);
  const entry = current?.runEntry ?? fs.realpathSync(bin);
  if (typeof process.execve !== 'function') throw new Error('Automatic Pi launch requires execve support (Node >=22.19 on macOS/Linux).');
  const isJs = /\.[cm]?js$/.test(entry);
  // execve keeps this PID: there is no hidden persistent supervisor or child Pi.
  process.execve(isJs ? hook.original.node : entry, isJs ? [hook.original.node, entry, ...args] : [entry, ...args], env);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { launch(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(`Pi maintenance: ${error.message}`); process.exitCode = 1; }
}
