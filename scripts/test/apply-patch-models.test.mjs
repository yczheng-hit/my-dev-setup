import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const host = process.env.PI_HOST_DIR;

let applyPatchModelsMod;
let syncCodexTools;
let load;
if (host) {
  const fromHost = createRequire(path.join(host, "package.json"));
  const { createJiti } = await import(
    pathToFileURL(path.join(path.dirname(fromHost.resolve("jiti/package.json")), "lib/jiti.mjs"))
  );
  const alias = {
    "@earendil-works/pi-coding-agent": path.join(host, "dist/index.js"),
    "typebox/value": fromHost.resolve("typebox/value"),
    typebox: fromHost.resolve("typebox"),
  };
  for (const name of ["pi-ai", "pi-tui", "pi-agent-core"]) {
    alias[`@earendil-works/${name}`] = fromHost.resolve
      .paths(`@earendil-works/${name}`)
      .map((base) => path.join(base, `@earendil-works/${name}/dist/index.js`))
      .find((file) => fs.existsSync(file));
  }
  const jiti = createJiti(import.meta.url, { alias, moduleCache: false, fsCache: false });
  const dir = fileURLToPath(
    new URL("../../packages/pi-openai-codex-compat/extensions/openai-codex-compat/", import.meta.url),
  );
  load = (relativePath) => jiti.import(path.join(dir, relativePath));
  applyPatchModelsMod = await load("apply-patch-models.ts");
  ({ syncCodexTools } = await load("tools.ts"));
}

test("isApplyPatchModel and toggleModelInApplyPatchModels toggle models between apply_patch and edit", { skip: !host }, () => {
  const {
    DEFAULT_APPLY_PATCH_MODELS,
    isApplyPatchModel,
    toggleModelInApplyPatchModels,
    buildApplyPatchModelSelectItems,
  } = applyPatchModelsMod;

  const codexModel = { provider: "openai-codex", id: "gpt-5.4" };
  const gptAstra = { provider: "nvidia-inference", id: "openai/openai/eccn-gpt-6-astra" };
  const claudeOpus = { provider: "local", id: "opus" };

  assert.equal(isApplyPatchModel(codexModel, DEFAULT_APPLY_PATCH_MODELS), true);
  assert.equal(isApplyPatchModel(gptAstra, DEFAULT_APPLY_PATCH_MODELS), false);
  assert.equal(isApplyPatchModel(claudeOpus, DEFAULT_APPLY_PATCH_MODELS), false);

  // Toggle gptAstra ON
  const afterEnableAstra = toggleModelInApplyPatchModels(
    DEFAULT_APPLY_PATCH_MODELS,
    "nvidia-inference/openai/openai/eccn-gpt-6-astra",
  );
  assert.equal(isApplyPatchModel(gptAstra, afterEnableAstra), true);
  assert.equal(isApplyPatchModel(codexModel, afterEnableAstra), true);
  assert.equal(isApplyPatchModel(claudeOpus, afterEnableAstra), false);

  // Toggle claudeOpus ON
  const afterEnableOpus = toggleModelInApplyPatchModels(afterEnableAstra, "local/opus");
  assert.equal(isApplyPatchModel(claudeOpus, afterEnableOpus), true);

  // Toggle gptAstra OFF
  const afterDisableAstra = toggleModelInApplyPatchModels(
    afterEnableOpus,
    "nvidia-inference/openai/openai/eccn-gpt-6-astra",
  );
  assert.equal(isApplyPatchModel(gptAstra, afterDisableAstra), false);
  assert.equal(isApplyPatchModel(claudeOpus, afterDisableAstra), true);

  // Check SelectList items format
  const items = buildApplyPatchModelSelectItems({
    currentModel: claudeOpus,
    availableModels: [claudeOpus, gptAstra, codexModel],
    patterns: afterDisableAstra,
  });
  assert.ok(items[0].label.includes("[apply_patch]"));
  assert.ok(items[0].label.includes("local/opus (current)"));
  const astraItem = items.find((i) => i.value === "nvidia-inference/openai/openai/eccn-gpt-6-astra");
  assert.ok(astraItem.label.includes("[edit (hashline)]"));
});

test("syncHashlineDisableOnModels writes disableOnModels and syncCodexTools swaps apply_patch and hashline tools on non-Codex models", { skip: !host }, () => {
  const { syncHashlineDisableOnModels } = applyPatchModelsMod;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-models-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ autoRead: true, disableOnModels: ["openai-codex/*"] }),
    );
    syncHashlineDisableOnModels("openai-codex/*, local/opus", true, tmpDir);
    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    assert.equal(updated.autoRead, true);
    assert.deepEqual(updated.disableOnModels, ["openai-codex/*", "local/opus"]);

    // Verify syncCodexTools switches local/opus between edit/hashline and apply_patch
    let activeTools = ["read", "bash", "write", "replace", "replace_match", "insert", "copy", "move", "undo_last_change"];
    const piMock = {
      getActiveTools: () => [...activeTools],
      setActiveTools: (next) => {
        activeTools = [...next];
      },
    };
    const opusModel = { provider: "local", id: "opus", api: "openai-completions" };

    syncCodexTools(
      piMock,
      opusModel,
      {
        fastMode: false,
        responsesLite: false,
        applyPatch: true,
        applyPatchModels: "openai-codex/*, local/opus",
        applyPatchDebug: false,
        applyPatchDiagnostics: false,
        toolBackground: "subtle",
        shellTool: "unified_exec",
        imageGeneration: true,
        imageDetail: "auto",
        webRun: false,
        webSearch: "disabled",
        textVerbosity: "low",
        reasoningSummary: "auto",
      },
      undefined,
      false,
    );

    assert.equal(activeTools.includes("apply_patch"), true);
    assert.equal(activeTools.includes("write"), false);
    assert.equal(activeTools.includes("replace"), false);
    assert.equal(activeTools.includes("bash"), true);

    // Now toggle local/opus back to edit (hashline)
    syncCodexTools(
      piMock,
      opusModel,
      {
        fastMode: false,
        responsesLite: false,
        applyPatch: true,
        applyPatchModels: "openai-codex/*",
        applyPatchDebug: false,
        applyPatchDiagnostics: false,
        toolBackground: "subtle",
        shellTool: "unified_exec",
        imageGeneration: true,
        imageDetail: "auto",
        webRun: false,
        webSearch: "disabled",
        textVerbosity: "low",
        reasoningSummary: "auto",
      },
      undefined,
      false,
    );

    assert.equal(activeTools.includes("apply_patch"), false);
    assert.equal(activeTools.includes("write"), true);
    assert.equal(activeTools.includes("replace"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test(
  "real AgentSession with pi-openai-codex-compat + pi-hashline-edit-pro switches tools and read format across models and same-model toggles",
  { skip: !host, timeout: 25000 },
  async () => {
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    const compatDir = path.join(repo, "packages/pi-openai-codex-compat");
    const hashlineDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-hashline-edit-pro");
    if (!fs.existsSync(hashlineDir)) return;

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-e2e-")));
    const savedEnv = { ...process.env };
    const oldCwd = process.cwd();
    let session;
    try {
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "work");
      const home = path.join(root, "home");
      for (const d of [agentDir, cwd, home]) fs.mkdirSync(d, { recursive: true });
      Object.assign(process.env, {
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        JITI_FS_CACHE: "false",
      });
      process.chdir(cwd);

      const sampleFile = path.join(cwd, "sample.txt");
      fs.writeFileSync(sampleFile, "alpha line\nbeta line\n", "utf8");

      // Seed both configs: openai-codex/* and local/gpt-6-astra use apply_patch; local/opus uses edit (hashline)
      fs.writeFileSync(
        path.join(agentDir, "openai-codex-compat.json"),
        JSON.stringify({
          applyPatch: true,
          applyPatchModels: "openai-codex/*, local/gpt-6-astra",
          imageGeneration: false,
          webRun: false,
        }),
      );
      const hashlineConfigDir = path.join(home, ".config/pi-hashline-edit-pro");
      fs.mkdirSync(hashlineConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(hashlineConfigDir, "config.json"),
        JSON.stringify({
          autoRead: true,
          disableOnModels: ["openai-codex/*"],
        }),
      );

      const sdk = await import(pathToFileURL(path.join(host, "dist/index.js")));
      const { AuthStorage } = await import(
        pathToFileURL(path.join(host, "dist/core/auth-storage.js"))
      );
      const runtime = await sdk.ModelRuntime.create({
        credentials: AuthStorage.inMemory({
          "openai-codex": {
            type: "oauth",
            access: `e30.${Buffer.from(
              JSON.stringify({
                "https://api.openai.com/auth": { chatgpt_account_id: "SYNTHETIC_ONLY" },
              }),
            ).toString("base64url")}.sig`,
            refresh: "SYNTHETIC_ONLY",
            expires: Date.now() + 3600000,
            accountId: "SYNTHETIC_ONLY",
          },
        }),
        modelsPath: null,
        modelsStorePath: path.join(root, "models.json"),
        refreshOnCreate: false,
      });
      runtime.registerProvider("local", {
        baseUrl: "https://fixture.invalid",
        api: "openai-completions",
        apiKey: "SYNTHETIC_ONLY",
        models: [
          {
            id: "opus",
            name: "Local Opus",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "gpt-6-astra",
            name: "Local GPT-6 Astra",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });

      const opusModel = runtime.getModel("local", "opus");
      const astraModel = runtime.getModel("local", "gpt-6-astra");
      const codexModel = runtime.getModel("openai-codex", "gpt-6.1-sol");

      const settings = sdk.SettingsManager.inMemory(
        {
          packages: [compatDir, hashlineDir],
          compaction: { enabled: false },
        },
        { projectTrusted: true },
      );
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        systemPrompt: "Synthetic prompt.",
        appendSystemPrompt: [],
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        noContextFiles: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);

      const sm = sdk.SessionManager.inMemory(cwd);
      ({ session } = await sdk.createAgentSession({
        cwd,
        agentDir,
        settingsManager: settings,
        modelRuntime: runtime,
        model: opusModel,
        thinkingLevel: "off",
        resourceLoader: loader,
        sessionManager: sm,
      }));
      const errors = [];
      await session.bindExtensions({ onError: (err) => errors.push(err) });
      assert.deepEqual(errors, []);

      const runRead = async () => {
        const readTool = session.agent.state.tools.find((t) => t.name === "read");
        assert.ok(readTool, "read tool must be active");
        const res = await readTool.execute("read-call", { path: "sample.txt" });
        return res.content.map((c) => c.text ?? "").join("\n");
      };

      // 1. Initial state on local/opus: edit (hashline) mode
      assert.equal(session.getActiveToolNames().includes("apply_patch"), false);
      assert.equal(session.getActiveToolNames().includes("replace"), true);
      assert.equal(session.getActiveToolNames().includes("write"), true);
      const opusRead1 = await runRead();
      assert.match(opusRead1, /^[a-z]{5}│alpha line/m, "local/opus read should have hashline anchors");

      // 2. Switch to local/gpt-6-astra (non-Codex model configured for apply_patch)
      await session.setModel(astraModel);
      assert.equal(session.getActiveToolNames().includes("apply_patch"), true);
      assert.equal(session.getActiveToolNames().includes("replace"), false);
      assert.equal(session.getActiveToolNames().includes("write"), false);
      assert.equal(session.getActiveToolNames().includes("bash"), true);
      const astraRead = await runRead();
      assert.doesNotMatch(astraRead, /^[a-z]{5}│/m, "gpt-6-astra read should be vanilla without anchors");
      assert.match(astraRead, /alpha line/);

      // Execute apply_patch on local/gpt-6-astra
      const patchTool = session.agent.state.tools.find((t) => t.name === "apply_patch");
      assert.ok(patchTool, "apply_patch tool must be in agent state tools");
      await patchTool.execute("patch-1", {
        patch: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-alpha line\n+alpha patched\n*** End Patch",
      });
      assert.equal(fs.readFileSync(sampleFile, "utf8"), "alpha patched\nbeta line\n");

      // 3. Switch back to local/opus -> should restore hashline tools and anchored read
      await session.setModel(opusModel);
      assert.equal(session.getActiveToolNames().includes("apply_patch"), false);
      assert.equal(session.getActiveToolNames().includes("replace"), true);
      assert.equal(session.getActiveToolNames().includes("write"), true);
      const opusRead2 = await runRead();
      assert.match(opusRead2, /^[a-z]{5}│alpha patched/m, "switching back to local/opus restores anchored read");

      // 4. Switch to openai-codex/gpt-6.1-sol -> apply_patch + exec_command + vanilla read
      await session.setModel(codexModel);
      assert.equal(session.getActiveToolNames().includes("apply_patch"), true);
      assert.equal(session.getActiveToolNames().includes("exec_command"), true);
      assert.equal(session.getActiveToolNames().includes("replace"), false);
      assert.equal(session.getActiveToolNames().includes("write"), false);
      const codexRead = await runRead();
      assert.doesNotMatch(codexRead, /^[a-z]{5}│/m, "codex read should be vanilla without anchors");

      // 5. Switch back to local/opus -> restores bash, replace, write, and anchored read
      await session.setModel(opusModel);
      assert.equal(session.getActiveToolNames().includes("apply_patch"), false);
      assert.equal(session.getActiveToolNames().includes("bash"), true);
      assert.equal(session.getActiveToolNames().includes("replace"), true);
      assert.equal(session.getActiveToolNames().includes("write"), true);
      const opusRead3 = await runRead();
      assert.match(opusRead3, /^[a-z]{5}│alpha patched/m);

      // 6. Same-model toggle: toggle local/opus ON for apply_patch, then reload (as /codex-settings does)
      fs.writeFileSync(
        path.join(agentDir, "openai-codex-compat.json"),
        JSON.stringify({
          applyPatch: true,
          applyPatchModels: "openai-codex/*, local/gpt-6-astra, local/opus",
          imageGeneration: false,
          webRun: false,
        }),
      );
      await session.reload();
      assert.equal(session.getActiveToolNames().includes("apply_patch"), true);
      assert.equal(session.getActiveToolNames().includes("replace"), false);
      assert.equal(session.getActiveToolNames().includes("write"), false);
      const opusReadAfterEnable = await runRead();
      assert.doesNotMatch(
        opusReadAfterEnable,
        /^[a-z]{5}│/m,
        "local/opus read becomes vanilla after enabling apply_patch on it",
      );

      // 7. Same-model toggle: toggle local/opus OFF back to edit (hashline), then reload
      fs.writeFileSync(
        path.join(agentDir, "openai-codex-compat.json"),
        JSON.stringify({
          applyPatch: true,
          applyPatchModels: "openai-codex/*, local/gpt-6-astra",
          imageGeneration: false,
          webRun: false,
        }),
      );
      await session.reload();
      assert.equal(session.getActiveToolNames().includes("apply_patch"), false);
      assert.equal(session.getActiveToolNames().includes("replace"), true);
      assert.equal(session.getActiveToolNames().includes("write"), true);
      const opusReadAfterDisable = await runRead();
      assert.match(
        opusReadAfterDisable,
        /^[a-z]{5}│alpha patched/m,
        "local/opus read returns to hashline anchors after disabling apply_patch on it",
      );
    } finally {
      try {
        await session?.dispose?.();
      } catch {}
      process.chdir(oldCwd);
      for (const k of Object.keys(process.env)) {
        if (!(k in savedEnv)) delete process.env[k];
      }
      Object.assign(process.env, savedEnv);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("hashline config path follows PI_HASHLINE_DIR and XDG_CONFIG_HOME like pi-hashline-edit-pro", { skip: !host }, () => {
  const { hashlineConfigPath } = applyPatchModelsMod;
  const savedOverride = process.env.PI_HASHLINE_DIR;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedHome = process.env.HOME;
  try {
    process.env.PI_HASHLINE_DIR = "/tmp/hashline-override";
    process.env.XDG_CONFIG_HOME = "/tmp/hashline-xdg";
    assert.equal(hashlineConfigPath(), "/tmp/hashline-override/config.json");
    delete process.env.PI_HASHLINE_DIR;
    assert.equal(hashlineConfigPath(), "/tmp/hashline-xdg/pi-hashline-edit-pro/config.json");
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/tmp/hashline-home";
    assert.equal(hashlineConfigPath(), "/tmp/hashline-home/.config/pi-hashline-edit-pro/config.json");
    assert.equal(hashlineConfigPath("/tmp/explicit"), "/tmp/explicit/config.json");
  } finally {
    if (savedOverride === undefined) delete process.env.PI_HASHLINE_DIR;
    else process.env.PI_HASHLINE_DIR = savedOverride;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("applyPatchModels parses from JSON, arrays, and the process environment", { skip: !host }, async () => {
  const { parseConfig, resolveConfig, parseEnvironmentConfig, configLayer, DEFAULT_CONFIG, CONFIG_ENVIRONMENT_VARIABLES } =
    await load("config.ts");

  assert.equal(DEFAULT_CONFIG.applyPatchModels, "openai-codex/*");
  assert.equal(resolveConfig({}, {}, {}).applyPatchModels, "openai-codex/*");
  assert.equal(parseConfig({ applyPatchModels: " a/* ,  b/c ,a/* " }).applyPatchModels, "a/*, b/c");
  assert.equal(parseConfig({ applyPatchModels: ["a/*", "b/c"] }).applyPatchModels, "a/*, b/c");
  assert.equal(parseConfig({ applyPatchModels: 42 }).applyPatchModels, undefined);
  assert.equal(parseConfig({ applyPatchModels: ["ok", 7] }).applyPatchModels, undefined);
  assert.equal(
    resolveConfig(parseConfig({ applyPatchModels: "a/*" }), {}, {}).applyPatchModels,
    "a/*",
  );
  assert.equal(configLayer(resolveConfig({}, {}, {})).applyPatchModels, "openai-codex/*");

  const environment = parseEnvironmentConfig({
    [CONFIG_ENVIRONMENT_VARIABLES.applyPatchModels]: "x/*, y/z",
  });
  assert.equal(environment.applyPatchModels, "x/*, y/z");
  assert.equal(
    resolveConfig(parseConfig({ applyPatchModels: "a/*" }), {}, environment).applyPatchModels,
    "x/*, y/z",
  );
  assert.equal(parseEnvironmentConfig({}).applyPatchModels, undefined);
});

test("the settings pane exposes applyPatchModels as a model multi-toggle row", { skip: !host }, async () => {
  const { settingFields } = await load("settings-pane.ts");
  const field = settingFields.find((entry) => entry.id === "applyPatchModels");
  assert.ok(field, "applyPatchModels setting row must exist");
  assert.equal(field.format("openai-codex/*, local/opus"), "2 rules");
  assert.equal(field.format("openai-codex/*"), "1 rule");
  assert.ok(field.multiToggle, "applyPatchModels row must expose a model multi-toggle");

  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-settings-row-"));
  try {
    process.env.PI_CODING_AGENT_DIR = tmpAgent;
    const items = field.multiToggle.getItems("openai-codex/*");
    assert.ok(
      items.some((item) => item.value === "openai-codex/*" && item.label.includes("[apply_patch]")),
      JSON.stringify(items),
    );
    assert.equal(field.multiToggle.onToggle("openai-codex/*", "local/opus"), "openai-codex/*, local/opus");
    assert.equal(field.multiToggle.onToggle("openai-codex/*, local/opus", "local/opus"), "openai-codex/*");
    assert.equal(field.multiToggle.onToggle("openai-codex/*", "openai-codex/*"), "");
    assert.equal(field.multiToggle.onToggle("", "local/opus"), "local/opus");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    fs.rmSync(tmpAgent, { recursive: true, force: true });
  }
});

test("turning applyPatch off restores Pi edit and hashline tools for a listed model", { skip: !host }, () => {
  const config = {
    fastMode: false,
    responsesLite: false,
    applyPatch: false,
    applyPatchModels: "openai-codex/*, local/opus",
    applyPatchDebug: false,
    applyPatchDiagnostics: false,
    toolBackground: "subtle",
    shellTool: "unified_exec",
    imageGeneration: true,
    imageDetail: "auto",
    webRun: false,
    webSearch: "disabled",
    textVerbosity: "low",
    reasoningSummary: "auto",
  };
  let activeTools = [
    "read",
    "bash",
    "grep",
    "write",
    "replace",
    "replace_match",
    "insert",
    "copy",
    "move",
    "undo_last_change",
  ];
  const piMock = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (next) => {
      activeTools = [...next];
    },
  };
  const opusModel = { provider: "local", id: "opus", api: "openai-completions" };

  syncCodexTools(piMock, opusModel, { ...config, applyPatch: true }, undefined, false);
  assert.equal(activeTools.includes("apply_patch"), true);
  assert.equal(activeTools.includes("replace"), false);
  assert.equal(activeTools.includes("write"), false);

  syncCodexTools(piMock, opusModel, config, undefined, false);
  assert.equal(activeTools.includes("apply_patch"), false);
  assert.equal(activeTools.includes("replace"), true);
  assert.equal(activeTools.includes("insert"), true);
  assert.equal(activeTools.includes("copy"), true);
  assert.equal(activeTools.includes("undo_last_change"), true);
  assert.equal(activeTools.includes("write"), true);
  assert.equal(activeTools.includes("bash"), true);
});
