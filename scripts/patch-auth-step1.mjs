import fs from 'node:fs';

// 1. cursor-auth.ts
let auth = fs.readFileSync('source/electron-main/account/cursor-auth.ts', 'utf8');
const staticAuth = `
export const LOCAL_MOCK_USER_ID = "local-user";
export const LOCAL_MOCK_STATUS: SandAuthStatus = Object.freeze({
  kind: "logged-in",
  authId: LOCAL_MOCK_USER_ID,
  email: "local@localhost",
  displayName: "Local User",
  isAnysphereUser: false,
  expiresAt: 4102444800000,
});
export const LOCAL_MOCK_TOKEN = "local-mock-token-never-expires";
`;

if (!auth.includes('LOCAL_MOCK_USER_ID')) {
  auth = auth.replace('export const REFRESH_TOKEN_SECRET_KEY = "cursor-refresh-token";', 'export const REFRESH_TOKEN_SECRET_KEY = "cursor-refresh-token";\n' + staticAuth);
}
auth = auth.replace(/async getStatus\(\): Promise<SandAuthStatus> \{[\s\S]*?return LOCAL_MOCK_STATUS;[\s\S]*?\}/, 'async getStatus(): Promise<SandAuthStatus> { return LOCAL_MOCK_STATUS; }');
auth = auth.replace(/async revokeCredentials\([\s\S]*?\): Promise<SandAuthStatus> \{[\s\S]*?\n  \}/, 'async revokeCredentials(): Promise<SandAuthStatus> { return LOCAL_MOCK_STATUS; }');
fs.writeFileSync('source/electron-main/account/cursor-auth.ts', auth, 'utf8');
console.log('cursor-auth.ts updated');

// 2. cursor-profile.ts
let profile = fs.readFileSync('source/electron-main/account/cursor-profile.ts', 'utf8');
const mockProfile = `
const STATIC_MOCK_PROFILE: CursorProfile = Object.freeze({
  displayName: "Local User",
  email: "local@localhost",
  profilePictureUrl: undefined,
  isAnysphereUser: false,
});
`;
if (!profile.includes('STATIC_MOCK_PROFILE')) {
  profile = mockProfile + '\n' + profile;
}
profile = profile.replace(/export async function fetchCursorProfile\([\s\S]*?\): Promise<CursorProfile \| null> \{[\s\S]*?\n\}/, 'export async function fetchCursorProfile(): Promise<CursorProfile | null> { return STATIC_MOCK_PROFILE; }');
fs.writeFileSync('source/electron-main/account/cursor-profile.ts', profile, 'utf8');
console.log('cursor-profile.ts updated');

// 3. coordinator-account-runtime.ts
let coord = fs.readFileSync('source/electron-main/coordinator/coordinator-account-runtime.ts', 'utf8');
coord = coord.replace(/this\.options\.revokeRefusedAccount\(\)/g, 'Promise.resolve({ kind: "accepted", status: { kind: "logged-in" } as any })');
fs.writeFileSync('source/electron-main/coordinator/coordinator-account-runtime.ts', coord, 'utf8');
console.log('coordinator-account-runtime.ts updated');

// 4. account-revoke.ts
let revoke = fs.readFileSync('source/electron-main/coordinator/account-revoke.ts', 'utf8');
revoke = revoke.replace(/return await \(await getAuthService\(\)\)\.revokeForAccountRefusal\(\);/, 'return { kind: "accepted", status: { kind: "logged-in" } as any };');
fs.writeFileSync('source/electron-main/coordinator/account-revoke.ts', revoke, 'utf8');
console.log('account-revoke.ts updated');

// 5. credential-renewer.ts
let credRenewer = fs.readFileSync('source/host/extensions/auth/credential-renewer.ts', 'utf8');
credRenewer = credRenewer.replace(/start\(\): void \{ this\.loop \?\?= this\.run\(\); \}/, 'start(): void { this.options.setCredential({ accessToken: "local-mock-token-never-expires", expiresAtMs: 4102444800000 }); }');
fs.writeFileSync('source/host/extensions/auth/credential-renewer.ts', credRenewer, 'utf8');
console.log('credential-renewer.ts updated');
