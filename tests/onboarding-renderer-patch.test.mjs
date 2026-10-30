import assert from "node:assert/strict";
import test from "node:test";
import { patchOriginalOnboardingBootstrap } from "../scripts/lib/router-renderer-patch.mjs";

const ORIGINAL_GATE = 'return t.status!=="ready"?{step:n4e,dailyTools:[],draft:Ptt}:{step:kMt(e.step,s),dailyTools:e.dailyTools,draft:e.draft}}';
const ORIGINAL_REOPEN = 'r=()=>{s(),n.sandAccess.snapshots.get().state==="granted"&&e&&(e=!1,n.firstRun.forceOnboarding())}';

test("temporary first-box failure cannot restart an onboarding session", () => {
  const source = `${ORIGINAL_GATE}function EOn(n){${ORIGINAL_REOPEN}}`;
  const patched = patchOriginalOnboardingBootstrap(source);

  assert.match(patched, /n\.firstRun\.snapshots\.get\(\)\.phase!=="onboarding"&&n\.firstRun\.forceOnboarding\(\)/);
  assert.doesNotMatch(patched, /n\.firstRun\.forceOnboarding\(\)\}\}/);
  assert.match(patched, /return\{step:kMt\(e\.step,s\),dailyTools:e\.dailyTools,draft:e\.draft\}/);
});

test("renderer patch fails closed if the upstream onboarding behavior changes", () => {
  assert.throws(() => patchOriginalOnboardingBootstrap("unrecognized renderer"), /anchor is missing or ambiguous/);
});
