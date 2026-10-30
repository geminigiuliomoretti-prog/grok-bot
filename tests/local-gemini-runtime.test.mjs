import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadCoordinatorRuntime() {
  const result = await build({
    entryPoints: ["source/electron-main/coordinator/coordinator-account-runtime.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

async function loadSettingsStore() {
  const result = await build({
    entryPoints: ["source/shared/node/settings/sand-settings-store.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

test("local Gemini starts the coordinator for logged-out users and can be selected after startup", async () => {
  const { createCoordinatorAccountRuntime, LOCAL_GEMINI_ACCOUNT_SLOT } = await loadCoordinatorRuntime();
  let localEnabled = false;
  const starts = [];
  const sessions = [];
  const runtime = createCoordinatorAccountRuntime({
    getLocalRuntimeSlot: () => localEnabled ? LOCAL_GEMINI_ACCOUNT_SLOT : null,
    authorizeAccount: async slot => { starts.push(slot); return slot === LOCAL_GEMINI_ACCOUNT_SLOT; },
    revokeRefusedAccount: async () => ({ kind: "ok", status: { kind: "logged-out" } }),
    prepareAccountTransition: async () => {},
    resetAccountState: () => {},
    revokeMainDataPort: () => {},
    deliverStatus: () => {},
    onProblem: message => { throw new Error(message); },
    createRuntime: () => {
      const session = { dispose: async () => {}, restart: async () => {}, requestRendererPort: () => {}, revokeRendererPortRequest: () => {} };
      sessions.push(session);
      return session;
    },
  });

  await runtime.start({ kind: "logged-out" });
  assert.equal(sessions.length, 0);
  localEnabled = true;
  await runtime.restart();
  assert.deepEqual(starts, [LOCAL_GEMINI_ACCOUNT_SLOT]);
  assert.equal(sessions.length, 1);
  await runtime.dispose();
});

test("local Gemini mode persists independently of a Cursor account", async () => {
  const { SandSettingsStore } = await loadSettingsStore();
  const directory = await mkdtemp(path.join(process.cwd(), ".test-local-gemini-"));
  const settingsPath = path.join(directory, "settings.json");
  try {
    const settings = new SandSettingsStore(settingsPath);
    assert.equal(settings.getBoxRuntime(), "local-docker");
    assert.equal(settings.getLocalGeminiEnabled(), false);
    settings.setLocalGeminiEnabled(true);
    settings.setInferenceProvider("gemini");
    settings.setBoxRuntime("local-docker");

    const afterRestart = new SandSettingsStore(settingsPath);
    assert.equal(afterRestart.getLocalGeminiEnabled(), true);
    assert.equal(afterRestart.getInferenceProvider(), "gemini");
    assert.equal(afterRestart.getBoxRuntime(), "local-docker");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
