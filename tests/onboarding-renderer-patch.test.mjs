import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { patchOriginalOnboardingBootstrap, patchOriginalPreloadRpc, patchOriginalSettingsRegistry, patchOriginalSettingsPanel } from "../scripts/lib/router-renderer-patch.mjs";

const ORIGINAL_GATE = 'return t.status!=="ready"?{step:n4e,dailyTools:[],draft:Ptt}:{step:kMt(e.step,s),dailyTools:e.dailyTools,draft:e.draft}}';
const ORIGINAL_REOPEN = 'r=()=>{s(),n.sandAccess.snapshots.get().state==="granted"&&e&&(e=!1,n.firstRun.forceOnboarding())}';
const LOCAL_GATE = 'isSignedIn:()=>n.desktop.getCursorAuthStatus().then(v=>{const b=v.kind==="logged-in";return f=b,b})';
const LOCAL_SIGNOUT = 'noteSignedOut:d=>u({kind:"signed-out",accountSlot:d})';

test("temporary first-box failure cannot restart an onboarding session", () => {
  const source = `${ORIGINAL_GATE}function EOn(n){${ORIGINAL_REOPEN}}${LOCAL_GATE}${LOCAL_SIGNOUT}`;
  const patched = patchOriginalOnboardingBootstrap(source);

  assert.match(patched, /n\.firstRun\.snapshots\.get\(\)\.phase!=="onboarding"&&n\.firstRun\.forceOnboarding\(\)/);
  assert.doesNotMatch(patched, /n\.firstRun\.forceOnboarding\(\)\}\}/);
  assert.match(patched, /return\{step:kMt\(e\.step,s\),dailyTools:e\.dailyTools,draft:e\.draft\}/);
  assert.match(patched, /getBoxRuntime\(\)/);
  assert.match(patched, /b\.mode==="local-docker"/);
  assert.match(patched, /setBoxRuntime\("local-docker"\)/);
  assert.doesNotMatch(patched, /RLocalGeminiSetup|Paste your Google Gemini API key/);
});

test("renderer patch fails closed if the upstream onboarding behavior changes", () => {
  assert.throws(() => patchOriginalOnboardingBootstrap("unrecognized renderer"), /anchor is missing or ambiguous/);
});

test("packaged preload exposes the local Gemini methods used during onboarding", () => {
  const original = 'const MAIN_METHOD_TABLE = {\n  getCursorAuthStatus: { args: "none" },\n};\nconst desktop = {\n  agent: {\n      setBoxRuntime: (mode) => edge("setBoxRuntime", { mode }),\n      clientPersistence: {\n    }\n  }\n};';
  const patched = patchOriginalPreloadRpc(original);
  assert.match(patched, /getLocalGeminiStatus: \{ args: "none" \}/);
  assert.match(patched, /configureLocalGemini: \{ args: "object" \}/);
  assert.match(patched, /getLocalGeminiStatus: \(\) => edge\("getLocalGeminiStatus"\)/);
  assert.match(patched, /configureLocalGemini: \(args\) => edge\("configureLocalGemini", args\)/);
  assert.equal(patchOriginalPreloadRpc(patched), patched);
  assert.throws(() => patchOriginalPreloadRpc("changed upstream preload"), /anchor is missing or ambiguous/);
});

test("Settings exposes Router and saves Gemini without waiting for Docker startup", () => {
  const registryAndOnboarding = patchOriginalOnboardingBootstrap(patchOriginalSettingsRegistry(`const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]${ORIGINAL_GATE}${ORIGINAL_REOPEN}${LOCAL_GATE}${LOCAL_SIGNOUT}`));
  assert.match(registryAndOnboarding, /id:"router",label:"Router"/);
  assert.match(registryAndOnboarding, /getBoxRuntime\(\)/);
  assert.match(registryAndOnboarding, /n\.firstRun\.snapshots\.get\(\)\.phase!=="onboarding"/);

  const registry = patchOriginalSettingsRegistry('const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]');
  assert.match(registry, /id:"router",label:"Router"/);

  const panel = patchOriginalSettingsPanel('function Sa(s){Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null;Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null}');
  assert.match(panel, /configureLocalGemini\(\{apiKey:r\.trim\(\)\}\)/);
});

test("saving a Gemini key does not start or switch the Docker runtime", async () => {
  const source = await readFile(new URL("../source/electron-main/adapters/main-rpc.ts", import.meta.url), "utf8");
  const configure = source.slice(source.indexOf("configureLocalGemini: async (apiKey) => {"));
  assert.match(configure, /userSecretsStore\.upsert\(\{ GEMINI_API_KEY: trimmed \}\)/);
  assert.doesNotMatch(configure, /startLocalDockerBox|setBoxRuntime\("local-docker"\)/);
  assert.match(configure, /void getLocalDockerStatus\(settingsPath\)/);
});
