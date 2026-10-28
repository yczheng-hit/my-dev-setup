// Real Pi orchestration, deterministic offline provider. UI lifecycle is tested separately.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const host = process.env.PI_HOST_DIR;
if (!host) throw new Error('Set PI_HOST_DIR to the installed Pi host');
const dir = mkdtempSync(join(tmpdir(), 'picc-turn-'));
try {
  mkdirSync(join(dir, 'agent')); mkdirSync(join(dir, 'work'));
  for (const action of ['no', 'refine', 'bypassPermissions']) {
    const log = join(dir, action + '.log');
    const result = spawnSync(process.execPath, [join(host, 'dist/bundle/cli.js'), '--offline', '--no-session', '--no-extensions', '-e', fileURLToPath(new URL('./fixtures/review-provider.ts', import.meta.url)), '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp', '--model', 'review-fixture/fixture', '--mode', 'json', 'review'], {
      cwd: join(dir, 'work'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HERDR_ENV: '', HERDR_PANE_ID: '', PI_CODING_AGENT_DIR: join(dir, 'agent'), PICC_PERMISSION_MODES_CONFIG_PATH: join(dir, 'config.json'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), REVIEW_LOG: log, REVIEW_ACTION: action },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout.slice(-1500));
    const count = readFileSync(log, 'utf8').trim().split('\n').length;
    assert.equal(count, action === 'bypassPermissions' ? 2 : 1, `automatic continuation for ${action}`);
    console.log(`PASS ${action}: ${count} model request(s)`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
