import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

// One ephemeral writer per Herdr socket. A contending invocation records fresh
// demand before returning; the writer drains it, including the lock-release race.
// No resident daemon, global cache cleanup, or periodic metadata refresh.
export async function coalesceSync(scan, {
  socket = process.env.HERDR_SOCKET_PATH,
  binary = process.env.HERDR_BIN_PATH || 'herdr',
  root = process.env.HERDR_PANE_SYNC_DIR || path.join(tmpdir(), `herdr-pane-sync-${process.getuid?.() ?? 'user'}`),
  debounceMs = 100,
} = {}) {
  if (!socket) return scan(); // Unknown identity: never merge unrelated sessions.
  const key = createHash('sha256').update(JSON.stringify([binary, socket])).digest('hex');
  const dir = path.join(root, key);
  const secureDirectory = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
      throw new Error(`Unsafe pane sync coordination directory: ${directory}`);
    }
  };
  await secureDirectory(root);
  await secureDirectory(dir);
  const request = path.join(dir, 'requested');
  const completed = path.join(dir, 'completed');
  const token = randomUUID();
  const temp = path.join(dir, `${process.pid}-${token}.tmp`);
  try { await writeFile(temp, token, { mode: 0o600, flag: 'wx' }); await rename(temp, request); }
  finally { await rm(temp, { force: true }); }
  const read = async (file) => {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe coordination token: ${file}`);
      return await readFile(file, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  while (await read(request) !== await read(completed)) {
    let lost;
    let release;
    try {
      release = await lockfile.lock(request, { realpath: false, stale: 10_000, update: 2_000, retries: 0,
        onCompromised: (error) => { lost = error; } });
    } catch (error) {
      if (error.code === 'ELOCKED') return { coalesced: true };
      throw error;
    }
    try {
      while (await read(request) !== await read(completed)) {
        await new Promise((resolve) => setTimeout(resolve, debounceMs));
        const generation = await read(request);
        if (lost) throw lost;
        await scan();
        if (lost) throw lost;
        const completedTemp = path.join(dir, `${process.pid}-${randomUUID()}.tmp`);
        try { await writeFile(completedTemp, generation, { mode: 0o600, flag: 'wx' }); await rename(completedTemp, completed); }
        finally { await rm(completedTemp, { force: true }); }
      }
    } finally { if (!lost) await release(); }
    // Recheck after release. A contender may have recorded demand while our
    // final pre-release read was already in flight and observed ELOCKED.
  }
  return { coalesced: false };
}
