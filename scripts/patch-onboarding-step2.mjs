import fs from 'node:fs';

// 1. host-settings-fields.ts
let hostFields = fs.readFileSync('source/electron-main/prefs/host-settings-fields.ts', 'utf8');
// Make getHasSeenOnboarding always return true
hostFields = hostFields.replace(/options\.store\.getHasSeenOnboarding\(\)/g, 'true');
fs.writeFileSync('source/electron-main/prefs/host-settings-fields.ts', hostFields, 'utf8');
console.log('host-settings-fields.ts updated');

// 2. settings-service.ts
let settingsServ = fs.readFileSync('source/host/extensions/settings/settings-service.ts', 'utf8');
settingsServ = settingsServ.replace(/hasSeenOnboarding:\s*this\.store\.getHasSeenOnboarding\(\)/g, 'hasSeenOnboarding: true');
settingsServ = settingsServ.replace(/hasSeenOnboarding:\s*hasSeenOnboarding/g, 'hasSeenOnboarding: true');
fs.writeFileSync('source/host/extensions/settings/settings-service.ts', settingsServ, 'utf8');
console.log('settings-service.ts updated');

// 3. frontend model.ts
let model = fs.readFileSync('frontend/src/recovered/features/onboarding/signed-in/model.ts', 'utf8');
model = model.replace(/export async function isOnboardingAccountOnboarded\([\s\S]*?\): Promise<boolean> \{[\s\S]*?\n\}/, 'export async function isOnboardingAccountOnboarded(): Promise<boolean> { return true; }');
fs.writeFileSync('frontend/src/recovered/features/onboarding/signed-in/model.ts', model, 'utf8');
console.log('frontend/model.ts updated');

// 4. first-box-gate.ts
let firstBox = fs.readFileSync('frontend/src/recovered/features/access/cover/first-box-gate.ts', 'utf8');
firstBox = firstBox.replace(/export function projectFirstBoxGate\([\s\S]*?\): FirstBoxGateState \{[\s\S]*?\n\}/, 'export function projectFirstBoxGate(): FirstBoxGateState { return { hasReachedBox: true, isAwaitingFirstBox: false }; }');
fs.writeFileSync('frontend/src/recovered/features/access/cover/first-box-gate.ts', firstBox, 'utf8');
console.log('frontend/first-box-gate.ts updated');
