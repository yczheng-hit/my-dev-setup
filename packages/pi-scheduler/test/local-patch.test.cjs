// local patch: compact prompts, display-only logs, Chinese local-time formatting.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extensions/scheduler/scheduler-core.cjs");
const { harness, until } = require("./helpers/runtime-harness.cjs");

const NOW = new Date(2026, 9, 22, 11, 0, 0); // local time

test("formatClock / formatRelativeZh use local wall-clock time in Chinese", () => {
	assert.equal(core.formatClock(new Date(2026, 9, 22, 11, 30), NOW), "11:30");
	assert.equal(core.formatClock(new Date(2026, 9, 23, 9, 5), NOW), "明天 09:05");
	assert.equal(core.formatClock(new Date(2026, 9, 25, 9, 5), NOW), "10-25 09:05");
	assert.equal(core.formatClock(new Date(2027, 0, 2, 9, 5), NOW), "2027-01-02 09:05");
	assert.equal(core.formatClock("garbage", NOW), "未知");
	assert.equal(core.formatRelativeZh(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW), "5 分钟后");
	assert.equal(core.formatRelativeZh(new Date(NOW.getTime() + 80 * 60_000 + 7_000).toISOString(), NOW), "1 小时 20 分钟后");
	assert.equal(core.formatRelativeZh(new Date(NOW.getTime() + 30_000).toISOString(), NOW), "30 秒后");
	assert.equal(core.formatRelativeZh(NOW.toISOString(), NOW), "即将");
});

test("describeTask is one compact line", () => {
	const task = core.createScheduledTask({ action: "shell", type: "interval", schedule: "5m", command: "gh run list", name: "CI", maxRuns: 6 }, NOW, () => "t1");
	assert.equal(core.describeTask(task, NOW), "命令 · 每 5m · 下次 11:05（5 分钟后） · 最多 6 次 :: gh run list");
});

test("schedule_task schema stays slim but still accepts legacy aliases", async () => {
	const h = await harness(__dirname + "/..", async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		await h.start();
		const props = Object.keys(h.tools.schedule_task.parameters.properties);
		for (const alias of ["when", "whenText", "payload", "title", "triggerTurn", "successPrompt", "failurePrompt"]) {
			assert.ok(!props.includes(alias), `${alias} is not advertised`);
		}
		assert.equal(h.tools.schedule_task.promptGuidelines.length, 1);
		const prepared = h.tools.schedule_task.prepareArguments({ action: "notify", whenText: "10m", message: "x" });
		const created = await h.call("schedule_task", prepared);
		assert.equal(created.details.task.schedule, "10m");
		const legacy = await h.call("schedule_task", { action: "notify", when: "1h", payload: "legacy", title: "old" });
		assert.equal(legacy.details.task.message, "legacy");
		assert.match(legacy.content[0].text, /「old」/);
	} finally { await h.close(); }
});

test("shell wake is one compact block: no empty stderr, no duplicate model message", async () => {
	const h = await harness(__dirname + "/..", async () => ({ code: 1, killed: false, stdout: "build failed\n", stderr: "" }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", schedule: "0.02s", command: "make ci", name: "CI", followUpPrompt: "Fix it." });
		await until(async () => (await h.tasks())[0]?.history?.[0]?.wakeDisposition === "delivered", "wake delivered");
		assert.equal(h.wakes.length, 1);
		const text = h.wakes[0].text;
		assert.match(text, /^⏰ 定时任务 task_\S+「CI」 运行完成 · \d{2}:\d{2}\n\$ make ci\n退出码 1 · 用时 \d/);
		assert.match(text, /输出：\n```\nbuild failed\n```\n下一步：Fix it\.$/);
		assert.doesNotMatch(text, /错误输出|STDERR|Scheduled for|Action:|目录：/);
		assert.equal(h.messages.length, 0, "nothing else enters model context");
		assert.equal(h.entries.length, 0, "no extra chat log when the agent is woken");
	} finally { await h.close(); }
});

test("unwoken shell runs and reminders are display-only log entries", async () => {
	const h = await harness(__dirname + "/..", async () => ({ code: 0, killed: false, stdout: "ok", stderr: "" }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", schedule: "0.02s", command: "true", name: "quiet" });
		await h.call("schedule_task", { action: "notify", schedule: "0.02s", message: "stretch", name: "break" });
		await until(async () => (await h.tasks()).every((task) => task.runCount === 1), "both ran");
		await until(async () => h.entries.length >= 2, "two log entries");
		assert.equal(h.messages.length, 0);
		assert.equal(h.wakes.length, 0);
		const texts = h.entries.map((entry) => entry.data.text).sort();
		assert.match(texts.find((t) => t.startsWith("🔔")), /^🔔 task_\S+「break」：stretch$/);
		const shell = h.entries.find((entry) => entry.data.text.startsWith("🖥"));
		assert.match(shell.data.text, /「quiet」 运行完成 · 退出码 0/);
		assert.equal(shell.data.detail, "$ true\nok");
		assert.ok(h.entries.every((entry) => entry.customType === "scheduled-task-log"));
	} finally { await h.close(); }
});

test("prompt wake has a one-line header and stored output is capped", async () => {
	const big = "x".repeat(20_000);
	const h = await harness(__dirname + "/..", async () => ({ code: 0, killed: false, stdout: big, stderr: big }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "prompt", schedule: "0.02s", prompt: "Check the deploy." });
		await h.call("schedule_task", { action: "shell", schedule: "0.02s", command: "spam", followUpPrompt: "Summarise." });
		await until(async () => h.wakes.length === 2, "both woke");
		const prompt = h.wakes.find((wake) => /Check the deploy/.test(wake.text)).text;
		assert.match(prompt, /^⏰ 定时任务 task_\S+ 到点 · \d{2}:\d{2}\nCheck the deploy\.$/);
		const shell = h.wakes.find((wake) => /spam/.test(wake.text)).text;
		assert.ok(shell.length < 6_500, `shell wake is ${shell.length} chars`);
		assert.match(shell, /…省略 \d+ 字符…/);
		const stored = (await h.tasks()).find((task) => task.command === "spam").result;
		assert.ok(stored.stdout.length < 4_100 && stored.stderr.length < 4_100);
	} finally { await h.close(); }
});

test("manage update still accepts unlisted schedule_task fields", async () => {
	const h = await harness(__dirname + "/..", async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		await h.start();
		const created = await h.call("schedule_task", { action: "shell", type: "interval", schedule: "1h", command: "a" });
		const id = created.details.task.id;
		const props = Object.keys(h.tools.manage_scheduled_task.parameters.properties);
		assert.ok(!props.includes("command") && !props.includes("followUpPrompt"));
		const updated = await h.call("manage_scheduled_task", { action: "update", id, command: "b", followUpPrompt: "look", maxRuns: 3, name: "renamed", stopOn: "success" });
		const task = updated.details.task;
		assert.deepEqual([task.command, task.followUpPrompt, task.maxRuns, task.name, task.stopOn], ["b", "look", 3, "renamed", "success"]);
		assert.match(updated.content[0].text, /^已更新 task_\S+「renamed」：命令 · 每 1h/);
	} finally { await h.close(); }
});
