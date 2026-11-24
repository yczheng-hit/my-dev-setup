import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseRestartArgs,
  buildRestartPlan,
  verifyPidInstallation,
  restartSinglePane,
} from "../pi-restart-herdr-panes.mjs";

test("parseRestartArgs handles default, all/--all, --pane, and --dry-run", () => {
  const def = parseRestartArgs([]);
  assert.equal(def.all, false);
  assert.equal(def.includeBusy, false);
  assert.equal(def.includeCurrent, false);

  const all = parseRestartArgs(["all"]);
  assert.equal(all.all, true);
  assert.equal(all.includeBusy, true);
  assert.equal(all.includeCurrent, true);

  const panes = parseRestartArgs(["--pane", "w8:p1,w9:p1", "wA:p1", "--dry-run", "--yes"]);
  assert.deepEqual(panes.panes, ["w8:p1", "w9:p1", "wA:p1"]);
  assert.equal(panes.dryRun, true);
  assert.equal(panes.yes, true);
});

test("buildRestartPlan skips current and busy panes by default, and includes them with all (current placed last)", () => {
  const sampleAgents = [
    {
      agent: "pi",
      pane_id: "w1:p3",
      agent_status: "working",
      cwd: "/repo/a",
      agent_session: { kind: "path", value: "/sessions/s1.jsonl" },
    },
    {
      agent: "pi",
      pane_id: "w8:p1",
      agent_status: "idle",
      cwd: "/repo/b",
      agent_session: { kind: "path", value: "/sessions/s2.jsonl" },
    },
    {
      agent: "pi",
      pane_id: "w9:p1",
      agent_status: "working",
      cwd: "/repo/c",
      agent_session: { kind: "path", value: "/sessions/s3.jsonl" },
    },
    {
      agent: "pi",
      pane_id: "wA:p1",
      agent_status: "idle",
      cwd: "/repo/d",
      agent_session: { kind: "path", value: "/sessions/missing.jsonl" },
    },
  ];
  const fileExists = (p) => p !== "/sessions/missing.jsonl";
  const env = { HERDR_PANE_ID: "w1:p3" };

  // Default plan: only w8:p1 is restarted
  const defPlan = buildRestartPlan(sampleAgents, parseRestartArgs([]), env, fileExists);
  assert.deepEqual(
    defPlan.toRestart.map((e) => e.paneId),
    ["w8:p1"],
  );
  assert.equal(defPlan.skipped.length, 3);

  // All plan: w8:p1, w9:p1, and w1:p3 (current pane ordered last); missing session still skipped
  const allPlan = buildRestartPlan(sampleAgents, parseRestartArgs(["all"]), env, fileExists);
  assert.deepEqual(
    allPlan.toRestart.map((e) => e.paneId),
    ["w8:p1", "w9:p1", "w1:p3"],
  );
  assert.equal(allPlan.toRestart.at(-1).isCurrent, true);
  assert.deepEqual(
    allPlan.skipped.map((e) => e.paneId),
    ["wA:p1"],
  );
});

test("verifyPidInstallation validates both Linux /proc environ and direct lsof host ownership", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-pid-")));
  try {
    const installDir = path.join(tmp, ".pi/agent/install");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "current-version"), "1.5.2\n");

    const mockFsGood = {
      existsSync: (p) => p === "/proc/1234/environ" || p.startsWith(installDir),
      readFileSync: (p) =>
        p === "/proc/1234/environ"
          ? `HOME=${tmp}\0PI_MANAGED_INSTALL_ROOT=${installDir}\0`
          : "1.5.2\n",
      realpathSync: (p) => p,
    };
    const goodLinux = verifyPidInstallation(1234, { version: "1.5.2" }, { fs: mockFsGood, home: tmp });
    assert.equal(goodLinux.ok, true);
    assert.equal(goodLinux.version, "1.5.2");

    const mockFsBad = {
      ...mockFsGood,
      readFileSync: (p) =>
        p === "/proc/1234/environ" ? `HOME=${tmp}\0PI_MANAGED_INSTALL_ROOT=/wrong/path\0` : "1.5.2\n",
    };
    const badLinux = verifyPidInstallation(1234, { version: "1.5.2" }, { fs: mockFsBad, home: tmp });
    assert.equal(badLinux.ok, false);
    assert.match(badLinux.reason, /PI_MANAGED_INSTALL_ROOT/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("restartSinglePane executes quit -> poll -> agent start --session -> process-info -> rename --clear", async () => {
  const calls = [];
  let pollCount = 0;
  const runCmd = (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "pane" && args[1] === "get") {
      pollCount += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { pane: { agent: pollCount < 2 ? "pi" : null } },
        }),
      };
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            process_info: {
              foreground_processes: [{ pid: 4242, argv0: "pi", name: "node" }],
            },
          },
        }),
      };
    }
    if (bin === "lsof") {
      return { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "{}" };
  };

  const res = await restartSinglePane(
    {
      paneId: "w8:p1",
      sessionFile: "/Users/test/.pi/agent/sessions/s1.jsonl",
    },
    {
      runCmd,
      installation: { version: "1.5.2", host: "/fake/host" },
      quitTimeoutMs: 5_000,
    },
  );

  assert.equal(res.paneId, "w8:p1");
  assert.equal(res.pid, 4242);
  assert.equal(res.version, "1.5.2");
  assert.ok(calls.some((c) => c.join(" ") === "herdr pane send-keys w8:p1 esc"));
  assert.ok(calls.some((c) => c.join(" ") === "herdr pane send-keys w8:p1 ctrl+c"));
  assert.ok(calls.some((c) => c.join(" ") === "herdr pane send-keys w8:p1 ctrl+d"));
  assert.ok(
    calls.some(
      (c) =>
        c[0] === "herdr" &&
        c[1] === "agent" &&
        c[2] === "start" &&
        c.includes("--session") &&
        c.includes("/Users/test/.pi/agent/sessions/s1.jsonl"),
    ),
  );
  assert.ok(calls.some((c) => c.join(" ") === "herdr agent rename w8:p1 --clear"));
});

function paneRunCmdMock({ startFailures = 0, allStartsFail = false, piAfterQuit = false } = {}) {
  const calls = [];
  let paneGets = 0;
  let starts = 0;
  let typedIntoShell = false;
  let startSucceeded = false;
  // Pi owns the pane's foreground: a successful start, our typed line, or a pane that came up on
  // its own even though `agent start` reported an error.
  const piRunning = () => startSucceeded || typedIntoShell || (piAfterQuit && starts > 0);
  const runCmd = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === "herdr" && args[0] === "pane" && args[1] === "get") {
      paneGets += 1;
      const agent = paneGets === 1 ? "pi" : piRunning() ? "pi" : null;
      return { status: 0, stdout: JSON.stringify({ result: { pane: { agent } } }) };
    }
    if (bin === "herdr" && args[0] === "pane" && args[1] === "run") {
      typedIntoShell = true;
      return { status: 0, stdout: "{}" };
    }
    if (bin === "herdr" && args[0] === "pane" && args[1] === "process-info") {
      const foreground = piRunning()
        ? [{ pid: 4242, argv0: "pi", name: "node" }]
        : [{ pid: 1111, argv0: "zsh", name: "zsh" }];
      return { status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: foreground } } }) };
    }
    if (bin === "herdr" && args[0] === "agent" && args[1] === "start") {
      starts += 1;
      const fail = allStartsFail || starts <= startFailures;
      if (!fail) startSucceeded = true;
      return fail ? { status: 1, stdout: "", stderr: "synthetic start failure" } : { status: 0, stdout: "{}" };
    }
    if (bin === "lsof") return { status: 0, stdout: "" };
    return { status: 0, stdout: "{}" };
  };
  return { calls, runCmd, starts: () => starts };
}

const FAST_OPTIONS = {
  quitTimeoutMs: 5_000,
  startRetryDelayMs: 1,
  shellPromptWaitMs: 5,
  shellOnlyWaitMs: 20,
  installation: { version: "1.5.2", host: "/fake/host" },
};

test("restartSinglePane retries agent start before falling back to a typed command", async () => {
  const mock = paneRunCmdMock({ startFailures: 1 });
  const res = await restartSinglePane(
    { paneId: "w8:p1", sessionFile: "/Users/test/.pi/agent/sessions/s1.jsonl" },
    { runCmd: mock.runCmd, ...FAST_OPTIONS },
  );
  assert.equal(res.pid, 4242);
  assert.equal(mock.starts(), 2, "retried once after the first failure");
  assert.ok(
    !mock.calls.some((c) => c[1] === "pane" && c[2] === "run"),
    "no typed command when a retry succeeds",
  );
  assert.ok(!mock.calls.some((c) => c.join(" ").includes("pi --session")));
});

test("restartSinglePane falls back to a quiet pane run command only after all retries fail", async () => {
  const mock = paneRunCmdMock({ allStartsFail: true });
  const res = await restartSinglePane(
    { paneId: "w8:p1", sessionFile: "/Users/test/.pi/agent/sessions/s1.jsonl" },
    { runCmd: mock.runCmd, startAttempts: 2, ...FAST_OPTIONS },
  );
  assert.equal(res.pid, 4242);
  assert.equal(mock.starts(), 2);
  const runCall = mock.calls.find((c) => c[1] === "pane" && c[2] === "run");
  assert.ok(runCall, "used pane run for the fallback");
  assert.equal(runCall[3], "w8:p1");
  assert.match(runCall[4], /^ pi --session '\/Users\/test\/\.pi\/agent\/sessions\/s1\.jsonl'$/);
  assert.ok(
    !mock.calls.some((c) => c[1] === "pane" && c[2] === "send-text"),
    "pane run replaces send-text",
  );
});

test("restartSinglePane never types into a pane that already runs pi", async () => {
  const mock = paneRunCmdMock({ allStartsFail: true, piAfterQuit: true });
  const res = await restartSinglePane(
    { paneId: "w8:p1", sessionFile: "/Users/test/.pi/agent/sessions/s1.jsonl" },
    { runCmd: mock.runCmd, startAttempts: 2, ...FAST_OPTIONS },
  );
  assert.equal(res.pid, 4242);
  assert.equal(mock.starts(), 2);
  assert.ok(
    !mock.calls.some((c) => c[1] === "pane" && (c[2] === "run" || c[2] === "send-text")),
    "nothing is typed when the pane already runs pi",
  );
});
