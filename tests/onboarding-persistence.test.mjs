import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function loadModel() {
  const source = await readFile(path.join(root, "frontend/src/recovered/features/onboarding/signed-in/model.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("persisted onboarding completion wins over an unavailable roster", async () => {
  const model = await loadModel();
  const completed = await model.isOnboardingAccountOnboarded({
    readSeen: async () => true,
    countAgents: async () => { throw new Error("coordinator unavailable"); },
  });
  assert.equal(completed, true);
  assert.equal(model.resolveOnboardingRoute({ isSignedIn: true, hasSeenOnboarding: true, agentCount: null }), "shell");
});

test("a new account with no agents remains eligible for onboarding", async () => {
  const model = await loadModel();
  assert.equal(await model.isOnboardingAccountOnboarded({ readSeen: async () => false, countAgents: async () => 0 }), false);
  assert.equal(model.resolveOnboardingRoute({ isSignedIn: true, hasSeenOnboarding: false, agentCount: 0 }), "onboarding");
});

test("desktop completion reads the persisted mirror and awaits durable host persistence", async () => {
  const [desktop, edge, legacyPatch] = await Promise.all([
    readFile(path.join(root, "source/electron-main/prefs/host-settings-fields.ts"), "utf8"),
    readFile(path.join(root, "source/electron-main/main-edge.ts"), "utf8"),
    readFile(path.join(root, "scripts/patch-onboarding-step2.mjs"), "utf8"),
  ]);
  assert.match(desktop, /read:\s*\(\)\s*=>\s*options\.store\.getHasSeenOnboarding\(\)/);
  assert.match(edge, /setOnboardingSeen:\s*async[\s\S]*?await Promise\.resolve\(invoke\(deps\.onboardingSeen, "apply", seen\)\)/);
  assert.doesNotMatch(legacyPatch, /getHasSeenOnboarding\(\).*true|hasSeenOnboarding:\s*true/);
});
