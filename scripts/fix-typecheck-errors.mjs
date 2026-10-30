import fs from 'node:fs';

// 1. Fix cursor-profile.ts: accept optional args in fetchCursorProfile so callers passing (getAccessToken, {}) don't error
let profile = fs.readFileSync('source/electron-main/account/cursor-profile.ts', 'utf8');
profile = profile.replace(
  'export async function fetchCursorProfile(): Promise<CursorProfile | null> { return STATIC_MOCK_PROFILE; }',
  'export async function fetchCursorProfile(_getAccessToken?: AccessTokenReader, _deps?: CursorProfileDeps): Promise<CursorProfile | null> { return STATIC_MOCK_PROFILE; }'
);
fs.writeFileSync('source/electron-main/account/cursor-profile.ts', profile, 'utf8');
console.log('cursor-profile.ts argument types fixed');

// 2. Fix cursor-auth.ts:
// Remove the duplicate declarations at lines 204-205 and ensure revokeCredentials accepts optional args
let auth = fs.readFileSync('source/electron-main/account/cursor-auth.ts', 'utf8');
auth = auth.replace('const LOCAL_MOCK_STATUS = { kind: "logged-in" as const, authId: "local-user", email: "local@localhost", displayName: "Local User", isAnysphereUser: false, expiresAt: 4102444800000 };\nconst LOCAL_MOCK_TOKEN = "local-dummy-token";\n', '');
auth = auth.replace(
  'private async revokeCredentials(): Promise<SandAuthStatus> { return LOCAL_MOCK_STATUS; }',
  'private async revokeCredentials(_options?: { emitStatus?: boolean; cause?: string; loggedOutStatus?: SandAuthStatus }): Promise<SandAuthStatus> { return LOCAL_MOCK_STATUS; }'
);
fs.writeFileSync('source/electron-main/account/cursor-auth.ts', auth, 'utf8');
console.log('cursor-auth.ts duplicate const and revokeCredentials fixed');

// 3. Fix production-binding-providers.ts:
// The tuple type in `as const` had [fn, string] | [fn, string]. Ensure it is cast properly: `as readonly [any, string][]`
let binding = fs.readFileSync('source/electron-main/production-binding-providers.ts', 'utf8');
binding = binding.replace(
  '] as const) requireFunction(value, label);',
  '] as readonly [any, string][]) requireFunction(value, label);'
);
fs.writeFileSync('source/electron-main/production-binding-providers.ts', binding, 'utf8');
console.log('production-binding-providers.ts tuple cast fixed');
