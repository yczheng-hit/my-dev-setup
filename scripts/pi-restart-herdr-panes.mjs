#!/usr/bin/env node
// Restart Pi panes in Herdr to the current installed version and restore each pane's exact session JSONL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectInstallation, executable } from "./maintenance-policy.mjs";

const DEFAULT_QUIT_TIMEOUT_MS = Number(process.env.QUIT_TIMEOUT ?? 25) * 1000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;

export function parseRestartArgs(argv) {
  const options = {
    all: false,
    includeBusy: false,
    includeCurrent: false,
    dryRun: false,
    yes: false,
    panes: [],
    quitTimeoutMs: DEFAULT_QUIT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "all" || arg === "--all" || arg === "-a") {
      options.all = true;
      options.includeBusy = true;
      options.includeCurrent = true;
    } else if (arg === "--include-busy" || arg === "busy") {
      options.includeBusy = true;
    } else if (arg === "--include-current" || arg === "current") {
      options.includeCurrent = true;
    } else if (arg === "--dry-run" || arg === "-n" || arg === "dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--pane" && argv[i + 1]) {
      for (const p of argv[++i].split(",")) {
        if (p.trim()) options.panes.push(p.trim());
      }
    } else if (arg.startsWith("--pane=")) {
      for (const p of arg.slice("--pane=".length).split(",")) {
        if (p.trim()) options.panes.push(p.trim());
      }
    } else if (/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(arg)) {
      options.panes.push(arg);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(
        `Unknown argument: ${arg}\nUsage: pi-restart-herdr-panes [all|--all] [--include-busy] [--include-current] [--pane <id>] [--dry-run] [--yes]`,
      );
    }
  }
  return options;
}

function runHerdrJson(args, runCmd = spawnSync) {
  const res = runCmd("herdr", args, { encoding: "utf8", timeout: 35_000 });
  if (res.error) throw res.error;
  const out = (res.stdout ?? "").trim();
  if (res.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed (${res.status}): ${(res.stderr || out).trim()}`);
  }
  return out ? JSON.parse(out) : {};
}

export function buildRestartPlan(agents, options = {}, env = process.env, fileExists = fs.existsSync) {
  const currentPaneId = env.HERDR_PANE_ID ?? "";
  const explicitPanes = new Set(options.panes ?? []);
  const filterByExplicit = explicitPanes.size > 0;

  const piAgents = (agents ?? []).filter((item) => item && item.agent === "pi");
  const entries = [];

  for (const item of piAgents) {
    const paneId = item.pane_id;
    const status = item.agent_status ?? "unknown";
    const sessionFile =
      item.agent_session?.kind === "path" && typeof item.agent_session?.value === "string"
        ? item.agent_session.value
        : undefined;
    const cwd = item.foreground_cwd || item.cwd || "";
    const isCurrent = Boolean(currentPaneId && paneId === currentPaneId);
    const isBusy = status === "working" || status === "blocked";

    if (filterByExplicit && !explicitPanes.has(paneId)) {
      continue;
    }

    let action = "restart";
    let reason = "ready";

    if (!sessionFile || !path.isAbsolute(sessionFile) || !fileExists(sessionFile)) {
      action = "skip";
      reason = "missing session .jsonl file";
    } else if (isCurrent && !options.includeCurrent && !options.all && !explicitPanes.has(paneId)) {
      action = "skip";
      reason = "current pane (pass --all or --include-current to include)";
    } else if (isBusy && !options.includeBusy && !options.all && !explicitPanes.has(paneId)) {
      action = "skip";
      reason = `status=${status} (pass --all or --include-busy to include)`;
    }

    entries.push({
      paneId,
      workspaceId: item.workspace_id ?? "",
      tabId: item.tab_id ?? "",
      status,
      sessionFile,
      cwd,
      isCurrent,
      isBusy,
      action,
      reason,
    });
  }

  // Always order current pane LAST so other panes finish restarting before the caller pane exits.
  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? 1 : -1;
    return a.paneId.localeCompare(b.paneId);
  });

  return {
    currentPaneId,
    entries,
    toRestart: entries.filter((e) => e.action === "restart"),
    skipped: entries.filter((e) => e.action === "skip"),
  };
}

export function formatRestartPlan(plan) {
  if (plan.entries.length === 0) {
    return "No matching Pi panes found in Herdr.";
  }
  const lines = [];
  for (const entry of plan.entries) {
    const tag = entry.action === "restart" ? "RESTART" : "SKIP   ";
    const cur = entry.isCurrent ? " [current]" : "";
    const shortSession = entry.sessionFile ? path.basename(entry.sessionFile) : "(no-session)";
    const dirName = entry.cwd ? path.basename(entry.cwd) || entry.cwd : "-";
    const detail = entry.action === "restart" ? shortSession : `${entry.reason}`;
    lines.push(`${tag}  ${entry.paneId.padEnd(7)}  ${entry.status.padEnd(7)}  ${dirName.padEnd(18)}  ${detail}${cur}`);
  }
  return lines.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function verifyPidInstallation(pid, expectedInstallation, options = {}) {
  const runCmd = options.runCmd ?? spawnSync;
  const fsMod = options.fs ?? fs;
  const home = options.home ?? os.homedir();
  const managedInstallDir = path.join(home, ".pi/agent/install");

  // 1. Linux /proc/<pid>/environ check when ~/.pi/agent/install exists
  const procEnviron = `/proc/${pid}/environ`;
  if (fsMod.existsSync(procEnviron) && fsMod.existsSync(managedInstallDir)) {
    try {
      const envVars = fsMod.readFileSync(procEnviron, "utf8").split("\0");
      const rootEntry = envVars.find((line) => line.startsWith("PI_MANAGED_INSTALL_ROOT="));
      const actualRoot = rootEntry ? rootEntry.slice("PI_MANAGED_INSTALL_ROOT=".length) : "";
      if (path.resolve(actualRoot || "") !== path.resolve(managedInstallDir)) {
        return {
          ok: false,
          reason: `PI_MANAGED_INSTALL_ROOT=${actualRoot || "<unset>"} !== ${managedInstallDir}`,
        };
      }
      const verFile = path.join(managedInstallDir, "current-version");
      const version = fsMod.existsSync(verFile)
        ? fsMod.readFileSync(verFile, "utf8").trim()
        : expectedInstallation?.version ?? "unknown";
      return { ok: true, version, host: managedInstallDir };
    } catch (err) {
      return { ok: false, reason: `Failed reading ${procEnviron}: ${err.message}` };
    }
  }

  // 2. Direct ownership verification (macOS & Linux via lsof + inspectInstallation)
  const expectedHost = expectedInstallation?.host
    ? fsMod.existsSync(expectedInstallation.host)
      ? fsMod.realpathSync(expectedInstallation.host)
      : expectedInstallation.host
    : undefined;
  const expectedVersion = expectedInstallation?.version;

  const lsof = runCmd("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 10_000 });
  const lsofOut = lsof.stdout ?? "";
  const fileLines = lsofOut
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1).trim());

  let detectedHost;
  for (const filePath of fileLines) {
    const marker = "/@earendil-works/pi-coding-agent/";
    const idx = filePath.indexOf(marker);
    if (idx !== -1) {
      detectedHost = filePath.slice(0, idx + marker.length - 1);
      break;
    }
  }

  if (detectedHost && fsMod.existsSync(detectedHost)) {
    const realDetected = fsMod.realpathSync(detectedHost);
    if (expectedHost && realDetected !== expectedHost) {
      return {
        ok: false,
        reason: `Loaded host ${realDetected} !== expected ${expectedHost}`,
      };
    }
    const pkgPath = path.join(realDetected, "package.json");
    const version = fsMod.existsSync(pkgPath)
      ? JSON.parse(fsMod.readFileSync(pkgPath, "utf8")).version
      : expectedVersion ?? "unknown";
    if (expectedVersion && version !== expectedVersion) {
      return {
        ok: false,
        reason: `Running version ${version} !== expected ${expectedVersion}`,
      };
    }
    return { ok: true, version, host: realDetected };
  }

  if (expectedInstallation?.version) {
    return { ok: true, version: expectedInstallation.version, host: expectedHost ?? "verified-by-start" };
  }
  return { ok: false, reason: `Could not verify Pi installation for pid ${pid}` };
}

export async function restartSinglePane(entry, options = {}) {
  const runCmd = options.runCmd ?? spawnSync;
  const expectedInstallation = options.installation ?? inspectInstallation();
  const quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const paneId = entry.paneId;

  const sendKey = (key) => {
    runCmd("herdr", ["pane", "send-keys", paneId, key], {
      encoding: "utf8",
      timeout: 5_000,
    });
  };

  // If restarting the current pane from a detached worker while it is still finishing a reply,
  // wait briefly (up to 15s) for it to settle to idle before sending quit keys.
  if (entry.isCurrent && options.waitForCurrentIdle) {
    const idleDeadline = Date.now() + 15_000;
    while (Date.now() < idleDeadline) {
      try {
        const info = runHerdrJson(["pane", "get", paneId], runCmd);
        const st = info?.result?.pane?.agent_status;
        if (!st || st === "idle" || st === "done") break;
      } catch {
        break;
      }
      await sleep(400);
    }
  }

  // Step 2: Graceful quit (double esc to dismiss any open modal/selector -> ctrl+c -> ctrl+d)
  sendKey("esc");
  await sleep(100);
  sendKey("esc");
  await sleep(150);
  sendKey("ctrl+c");
  await sleep(150);
  sendKey("ctrl+d");

  const deadline = Date.now() + quitTimeoutMs;
  let exited = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const info = runHerdrJson(["pane", "get", paneId], runCmd);
    const activeAgent = info?.result?.pane?.agent;
    if (!activeAgent) {
      exited = true;
      break;
    }
  }

  if (!exited) {
    // Fallback: two ctrl+c + ctrl+d
    sendKey("esc");
    await sleep(100);
    sendKey("ctrl+c");
    await sleep(120);
    sendKey("ctrl+c");
    await sleep(150);
    sendKey("ctrl+d");
    const forceDeadline = Date.now() + 5_000;
    while (Date.now() < forceDeadline) {
      await sleep(POLL_INTERVAL_MS);
      const info = runHerdrJson(["pane", "get", paneId], runCmd);
      if (!info?.result?.pane?.agent) {
        exited = true;
        break;
      }
    }
  }

  if (!exited) {
    throw new Error(`Pane ${paneId} did not exit Pi within ${Math.round(quitTimeoutMs / 1000)}s`);
  }

  // Step 3: Restart in the same pane with exact --session <jsonl>
  const tempName = `pi-restart-${paneId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);
  try {
    runHerdrJson(
      [
        "agent",
        "start",
        tempName,
        "--kind",
        "pi",
        "--pane",
        paneId,
        "--timeout",
        String(startTimeoutMs),
        "--",
        "--session",
        entry.sessionFile,
      ],
      runCmd,
    );
  } catch (startErr) {
    // Fallback recovery so a pane is never left stranded at an empty shell prompt
    const escapedSession = `'${String(entry.sessionFile).replace(/'/g, "'\\''")}'`;
    runCmd("herdr", ["pane", "send-text", paneId, `pi --session ${escapedSession}\r`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const recoverDeadline = Date.now() + 15_000;
    let recovered = false;
    while (Date.now() < recoverDeadline) {
      await sleep(POLL_INTERVAL_MS);
      const info = runHerdrJson(["pane", "get", paneId], runCmd);
      if (info?.result?.pane?.agent === "pi") {
        recovered = true;
        break;
      }
    }
    if (!recovered) throw startErr;
  }

  // Step 4: Process & version verification + clear temporary name
  const procInfo = runHerdrJson(["pane", "process-info", "--pane", paneId], runCmd);
  const fgList = procInfo?.result?.process_info?.foreground_processes ?? [];
  const fgProc = fgList.find((p) => p.argv0 === "pi" || p.name === "pi" || p.name === "node") ?? fgList[0];
  if (!fgProc?.pid) {
    throw new Error(`BAD ${paneId}: no foreground pi process found after start`);
  }

  const verification = verifyPidInstallation(fgProc.pid, expectedInstallation, { runCmd });
  runHerdrJson(["agent", "rename", paneId, "--clear"], runCmd);

  if (!verification.ok) {
    throw new Error(`BAD ${paneId} (pid=${fgProc.pid}): ${verification.reason}`);
  }

  // Step 5: Optional color restore hook
  if (executable("pi-fix-colors")) {
    runCmd("pi-fix-colors", ["--pane", paneId], { encoding: "utf8", timeout: 5_000 });
  }

  return {
    paneId,
    pid: fgProc.pid,
    version: verification.version,
    sessionFile: entry.sessionFile,
  };
}

async function promptCliConfirmation(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^(y|yes)$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseRestartArgs(argv);
  if (options.help) {
    console.log(
      "Usage: pi-restart-herdr-panes [all|--all] [--include-busy] [--include-current] [--pane <id>] [--dry-run] [--yes]",
    );
    return 0;
  }

  if (process.env.HERDR_ENV !== "1" && !options.dryRun) {
    throw new Error("pi-restart-herdr-panes must be run inside a Herdr pane (requires HERDR_ENV=1).");
  }

  const listJson = runHerdrJson(["agent", "list"]);
  const agents = listJson?.result?.agents ?? [];
  const plan = buildRestartPlan(agents, options);

  console.log(formatRestartPlan(plan));

  if (options.dryRun) {
    console.log(`\nDry run: ${plan.toRestart.length} pane(s) would be restarted, ${plan.skipped.length} skipped.`);
    return 0;
  }

  if (plan.toRestart.length === 0) {
    console.log("\nNo Pi panes eligible for restart.");
    return 0;
  }

  if (!options.yes) {
    const names = plan.toRestart.map((e) => `${e.paneId}${e.isCurrent ? "(current)" : ""}`).join(", ");
    const approved = await promptCliConfirmation(
      `\n确认重启以上 ${plan.toRestart.length} 个 Pi 面板 [${names}]？[y/N] `,
    );
    if (!approved) {
      console.log("已取消重启。");
      return 0;
    }
  }

  const installation = inspectInstallation();
  const isDetachedSelf = process.env.PI_RESTART_DETACHED === "1";
  let failures = 0;

  for (const entry of plan.toRestart) {
    if (entry.isCurrent && !isDetachedSelf) {
      const selfScript = fileURLToPath(import.meta.url);
      const child = spawn(
        process.execPath,
        [selfScript, "--yes", `--pane=${entry.paneId}`, "--include-busy", "--include-current"],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, PI_RESTART_DETACHED: "1" },
        },
      );
      child.unref();
      console.log(
        `SCHEDULED\t${entry.paneId}\tself-restart detached (will wait for idle and restore ${path.basename(entry.sessionFile)})`,
      );
      continue;
    }

    try {
      const result = await restartSinglePane(entry, {
        installation,
        quitTimeoutMs: options.quitTimeoutMs,
        waitForCurrentIdle: entry.isCurrent && isDetachedSelf,
      });
      console.log(
        `OK\t${result.paneId}\tpid=${result.pid}\tcurrent-version=${result.version}\tsession=${path.basename(result.sessionFile)}`,
      );
    } catch (err) {
      failures += 1;
      console.error(`BAD\t${entry.paneId}\t${err?.message ?? String(err)}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isMain) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`BAD\t${err?.message ?? String(err)}`);
      process.exit(1);
    },
  );
}
