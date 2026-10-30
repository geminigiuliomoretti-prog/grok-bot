import assert from "node:assert/strict";
import test from "node:test";
import { patchOriginalOnboardingBootstrap, patchOriginalPreloadRpc } from "../scripts/lib/router-renderer-patch.mjs";

const ORIGINAL_GATE = 'return t.status!=="ready"?{step:n4e,dailyTools:[],draft:Ptt}:{step:kMt(e.step,s),dailyTools:e.dailyTools,draft:e.draft}}';
const ORIGINAL_REOPEN = 'r=()=>{s(),n.sandAccess.snapshots.get().state==="granted"&&e&&(e=!1,n.firstRun.forceOnboarding())}';
const LOCAL_GATE = 'isSignedIn:()=>n.desktop.getCursorAuthStatus().then(v=>{const b=v.kind==="logged-in";return f=b,b})';
const LOCAL_SIGNOUT = 'noteSignedOut:d=>u({kind:"signed-out",accountSlot:d})';
const LOCAL_SETUP = 'l=p.jsx(h0t,{headingId:t,opticalDropPx:cjn,tagline:"Your team of always-on agents that you can give real work to.",children:o}),e[4]=t,e[5]=o,e[6]=l):l=e[6]';

test("temporary first-box failure cannot restart an onboarding session", () => {
  const source = `${ORIGINAL_GATE}function EOn(n){${ORIGINAL_REOPEN}}${LOCAL_GATE}${LOCAL_SIGNOUT}function gjn(n){${LOCAL_SETUP}}`;
  const patched = patchOriginalOnboardingBootstrap(source);

  assert.match(patched, /n\.firstRun\.snapshots\.get\(\)\.phase!=="onboarding"&&n\.firstRun\.forceOnboarding\(\)/);
  assert.doesNotMatch(patched, /n\.firstRun\.forceOnboarding\(\)\}\}/);
  assert.match(patched, /return\{step:kMt\(e\.step,s\),dailyTools:e\.dailyTools,draft:e\.draft\}/);
  assert.match(patched, /getLocalGeminiStatus\(\)/);
  assert.match(patched, /configureLocalGemini\(\{apiKey:s\}\)/);
  assert.match(patched, /children:p\.jsxs\("div",\{children:\[o,p\.jsx\(RLocalGeminiSetup/);
});

test("renderer patch fails closed if the upstream onboarding behavior changes", () => {
  assert.throws(() => patchOriginalOnboardingBootstrap("unrecognized renderer"), /anchor is missing or ambiguous/);
});

test("packaged preload exposes the local Gemini methods used during onboarding", () => {
  const patched = patchOriginalPreloadRpc('const MAIN_METHOD_TABLE = {\n  getCursorAuthStatus: { args: "none" },\n};');
  assert.match(patched, /getLocalGeminiStatus: \{ args: "none" \}/);
  assert.match(patched, /configureLocalGemini: \{ args: "object" \}/);
  assert.throws(() => patchOriginalPreloadRpc("changed upstream preload"), /anchor is missing or ambiguous/);
});
