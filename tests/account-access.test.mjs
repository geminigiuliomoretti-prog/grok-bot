import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAccess() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["source/electron-main/account/access.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

test("account access is read from the backend and preserves entitlement denial", async () => {
  const access = await loadAccess();
  let requestCount = 0;
  const result = await access.fetchSandAccess(async () => "valid-session-token", {
    createClient: ({ getAccessToken, getMachineId }) => ({
      async getSandAccessStatus(request, options) {
        requestCount += 1;
        assert.deepEqual(request, {});
        assert.equal(options.timeoutMs, access.SAND_ACCESS_REQUEST_TIMEOUT_MS);
        assert.equal(await getAccessToken(), "valid-session-token");
        assert.equal(await getMachineId(), "test-machine");
        return { state: 2, blockReason: 4 };
      },
    }),
    getMachineId: async () => "test-machine",
  });

  assert.equal(requestCount, 1);
  assert.deepEqual(result, { state: "unavailable", reason: "teamAccessRequired" });
});

test("an unauthenticated account remains unknown instead of receiving synthetic access", async () => {
  const access = await loadAccess();
  const result = await access.readSandAccessOnce({
    getAuthStatus: async () => ({ kind: "logged-out" }),
    readAccess: async () => { throw new Error("must not query entitlement without an account"); },
  });

  assert.deepEqual(result, { identity: null, access: { state: "unknown", reason: "unspecified" } });
});

test("Cursor authentication never submits the local mock token", async () => {
  const auth = await readFile(path.join(root, "source/electron-main/account/cursor-auth.ts"), "utf8");
  const profile = await readFile(path.join(root, "source/electron-main/account/cursor-profile.ts"), "utf8");
  assert.doesNotMatch(auth, /LOCAL_MOCK_(?:STATUS|TOKEN)|local-mock-token/);
  assert.doesNotMatch(profile, /STATIC_MOCK_PROFILE|local@localhost/);
  assert.match(auth, /async getStatus\(\): Promise<SandAuthStatus> \{/);
  assert.match(auth, /async getValidAccessToken\(options\?:/);
});
