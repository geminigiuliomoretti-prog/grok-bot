import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";

export function getAgentContainerName(agentId?: string): string {
  if (!agentId || agentId === "default") return LOCAL_DOCKER_BOX_CONTAINER;
  const cleanId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return `grok-box-${cleanId}`;
}

export function getAgentPortOffset(agentId?: string): number {
  if (!agentId || agentId === "default") return 0;
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash) + agentId.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 50) * 10;
}

export function getAgentGatewayUrl(agentId?: string): string {
  const offset = getAgentPortOffset(agentId);
  return `http://127.0.0.1:${1340 + offset}`;
}
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
export const LOCAL_DOCKER_SCHEMA_VERSION = "6";
const READY_TIMEOUT_MS = 180_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }

function runDocker(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

function credentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-vm.json");
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = credentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length >= 32) return parsed.token;
  } catch {}
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return token;
}

async function gatewayReady(token: string, gatewayUrl = LOCAL_DOCKER_GATEWAY_URL): Promise<boolean> {
  try {
    const response = await fetch(`${gatewayUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

async function inspectContainer(containerName = LOCAL_DOCKER_BOX_CONTAINER): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; hasInferenceCredential: boolean; schemaVersion: string }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", containerName]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", hasInferenceCredential: false, schemaVersion: "" };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

let localHostProcess: any = null;

function findNodeExecutable(): string {
  if (process.platform === 'win32') {
    const candidates = [
      'node.exe',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      join(homedir(), 'AppData\\Roaming\\nvm\\current\\node.exe'),
      join(homedir(), 'AppData\\Local\\Programs\\node\\node.exe'),
    ];
    for (const c of candidates) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {}
    }
    return 'node.exe';
  }
  return 'node';
}

function resolveDepsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as any).resourcesPath ?? resolve(dirname(process.execPath), "resources");
  const unpackedFromModule = moduleDirectory.includes("app.asar")
    ? resolve(moduleDirectory.replace(/app\.asar([\\/]|$)/, "app.asar.unpacked$1"), "../deps")
    : "";
  const candidates = [
    unpackedFromModule,
    resolve(resourcesPath, "app.asar.unpacked/dist/deps"),
    resolve(dirname(process.execPath), "resources/app.asar.unpacked/dist/deps"),
    resolve(moduleDirectory, "../../app.asar.unpacked/dist/deps"),
    resolve(moduleDirectory, "../../../app.asar.unpacked/dist/deps"),
    resolve(process.cwd(), "dist/deps"),
    resolve(process.cwd(), ".build/baseline-onboarding-copy-stage/dist/deps"),
    resolve(moduleDirectory, "../deps"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (/[\\/]app\.asar([\\/]|$)/.test(c)) continue;
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {}
  }
  return "";
}

async function freeStalePortIfDead(port: number): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
    for (const line of output.split("\n")) {
      if (line.includes(":" + port) && line.includes("LISTENING")) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0" && pid !== String(process.pid)) {
          execSync("taskkill /pid " + pid + " /F /T", { stdio: "ignore" });
        }
      }
    }
  } catch {}
}

async function ensureLocalNativeHost(settingsPath: string, inferenceCredential?: InferenceCredential, agentId?: string): Promise<GatewayConnection> {
  const token = await readOrCreateToken(settingsPath);
  const gatewayUrl = getAgentGatewayUrl(agentId);
  if (await gatewayReady(token, gatewayUrl)) {
    return { baseUrl: gatewayUrl, token };
  }
  const offset = getAgentPortOffset(agentId);
  const port = 1340 + offset;
  await freeStalePortIfDead(port);

  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const depsDir = resolveDepsDir();
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const rootDir = dirname(settingsPath);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SAND_PACKAGED: "1",
    SAND_DATA_ROOT: rootDir,
    SAND_SUPERVISOR_ENABLED: "1",
    SAND_BOX_AUTO_UPDATE: "0",
    SAND_USE_EXISTING_BOX_EXEC_DAEMON: "0",
    SAND_BOX_EXEC_DAEMON_PATH: hostBundle.boxExecDaemonPath,
    SAND_GATEWAY_BIND_HOST: "127.0.0.1",
    SAND_HOST_PORT: String(port),
    SAND_GATEWAY_TOKEN: token,
    SAND_BACKEND_URL: inferenceCredential?.backendUrl ?? "https://api2.cursor.sh/",
    ...(depsDir ? { NODE_PATH: depsDir, SAND_TREE_SITTER_NODE_DEPS: depsDir } : {}),
    ...(inferenceFile ? { SAND_DEV_INFERENCE_TOKEN_FILE: inferenceFile } : {}),
  };
  try {
    const electron = require("electron");
    if (electron?.safeStorage?.isEncryptionAvailable()) {
      const userSecretsPath = join(electron.app.getPath("userData"), "user-secrets.json");
      const raw = JSON.parse(await readFile(userSecretsPath, "utf8"));
      const decryptedSecrets: Record<string, string> = {};
      for (const acc of Object.values(raw.accounts ?? {})) {
        if (typeof acc === "object" && acc != null) {
          for (const [k, v] of Object.entries(acc as Record<string, string>)) {
            try {
              decryptedSecrets[k] = electron.safeStorage.decryptString(Buffer.from(v, "base64"));
            } catch {}
          }
        }
      }
      if (Object.keys(decryptedSecrets).length > 0) {
        const boxSecretsFile = join(rootDir, "box-secrets.json");
        let existingBoxSecrets: Record<string, string> = {};
        try {
          const parsed = JSON.parse(await readFile(boxSecretsFile, "utf8"));
          if (parsed && typeof parsed.secrets === "object") existingBoxSecrets = parsed.secrets;
        } catch {}
        Object.assign(existingBoxSecrets, decryptedSecrets);
        await writeFile(boxSecretsFile, JSON.stringify({ version: 1, secrets: existingBoxSecrets }, null, 2), "utf8");
        const envFile = join(rootDir, ".env");
        let envContent = "";
        try { envContent = await readFile(envFile, "utf8"); } catch {}
        for (const [k, v] of Object.entries(existingBoxSecrets)) {
          env[k] = v;
          const reg = new RegExp("^" + k + "=.*$", "m");
          if (reg.test(envContent)) envContent = envContent.replace(reg, k + "=" + v);
          else envContent += "\n" + k + "=" + v + "\n";
        }
        await writeFile(envFile, envContent.trim() + "\n", "utf8");
      }
    }
  } catch {}

  try {
    const boxSecretsFile = join(rootDir, "box-secrets.json");
    const parsed = JSON.parse(await readFile(boxSecretsFile, "utf8"));
    if (parsed && typeof parsed.secrets === "object") {
      for (const [k, v] of Object.entries(parsed.secrets)) {
        if (typeof v === "string") env[k] = v;
      }
    }
  } catch {}

  const nodeExecutable = findNodeExecutable();
  const child = spawn(nodeExecutable, [hostBundle.path], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });

  try {
    const logsDir = join(rootDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const logFile = createWriteStream(join(logsDir, "native-host.log"), { flags: "a" });
    child.stdout?.pipe(logFile);
    child.stderr?.pipe(logFile);
  } catch {}

  let childStderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr += chunk.toString();
    if (childStderr.length > 50_000) childStderr = childStderr.slice(-50_000);
  });

  child.unref();
  localHostProcess = child;

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await gatewayReady(token, gatewayUrl)) {
      return { baseUrl: gatewayUrl, token };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Local computer process did not expose its gateway within 15 seconds. " + childStderr.trim());
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const token = await readOrCreateToken(settingsPath);
  if (await gatewayReady(token)) {
    return { available: true, running: true, ready: true, containerName: "local-native", image: "native-node", detail: "Local computer is ready." };
  }
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (daemon.ok) {
    const inspected = await inspectContainer();
    if (inspected.exists && inspected.running && await gatewayReady(token)) {
      return { available: true, running: true, ready: true, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: "Local Docker VM is ready." };
    }
  }
  return { available: true, running: false, ready: false, containerName: "local-native", image: "native-node", detail: "Ready to start local computer." };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persistRuntime = async (name: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    }
    return target;
  };
  await mkdir(directory, { recursive: true });
  await persistRuntime("host-main.cjs", hostBytes);
  const hostPath = await persistRuntime("host/host-main.cjs", hostBytes);
  const boxExecDaemonPath = await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes);
  for (const workerRel of [
    "host/agent-isolation/agent-store-worker.cjs",
    "host/agent-isolation/transcript-mirror-worker.cjs",
    "host/extensions/box-store-sync/box-store-vacuum-worker.cjs",
    "host/extensions/content-search/search-index-worker.cjs",
  ]) {
    try {
      const workerBytes = await readRuntime(workerRel);
      await persistRuntime(workerRel, workerBytes);
      await persistRuntime(workerRel.replace(/^host\//, ""), workerBytes);
    } catch {}
  }
  try {
    const parentDaemon = join(directory, "..", "box-exec-daemon", "main.cjs");
    await mkdir(dirname(parentDaemon), { recursive: true });
    await writeFile(parentDaemon, boxExecDaemonBytes, { mode: 0o600 });
  } catch {}
  return {
    path: hostPath,
    sha256,
    boxExecDaemonPath,
    boxExecDaemonSha256,
  };
}

async function localAuthMountArguments(): Promise<string[]> {
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential, agentId?: string): Promise<GatewayConnection> {
  try {
    return await ensureLocalNativeHost(settingsPath, inferenceCredential, agentId);
  } catch (nativeError) {
    const daemonCheck = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
    if (!daemonCheck.ok) throw nativeError;
  }
  const containerName = getAgentContainerName(agentId);
  const offset = getAgentPortOffset(agentId);
  const gatewayUrl = getAgentGatewayUrl(agentId);
  const token = await readOrCreateToken(settingsPath);
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) throw new Error(`Local Docker VM is selected, but Docker is unavailable: ${daemon.output || "start Docker and try again"}`);
  const inspected = await inspectContainer(containerName);
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${containerName}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== LOCAL_DOCKER_BOX_IMAGE) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  if (inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential))) {
    const removed = await runDocker(["rm", "--force", containerName]);
    if (!removed.ok) throw new Error(`Could not replace the local VM with the current app runtime: ${removed.output}`);
  }
  const shouldReplace = inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential));
  const current = shouldReplace ? await inspectContainer(containerName) : inspected;
  if (current.exists && !current.running) {
    const started = await runDocker(["start", containerName]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    const authMounts = await localAuthMountArguments();
    const created = await runDocker([
      "run", "--detach", "--name", containerName,
      "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${hostBundle.sha256}`,
      "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${hostBundle.boxExecDaemonSha256}`,
      "--label", `com.grok-bot.local-vm.inference-credential=${inferenceCredential == null ? "0" : "1"}`,
      "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
      "--platform", "linux/amd64", "--restart", "unless-stopped",
      "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${token}`,
      ...(inferenceCredential == null ? [] : ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${inferenceCredential.backendUrl}`]),
      "--publish", `127.0.0.1:${1337 + offset}:1337`, "--publish", `127.0.0.1:${1339 + offset}:1339`, "--publish", `127.0.0.1:${1340 + offset}:1340`,
      "--publish", `127.0.0.1:${6080 + offset}:6080`, "--publish", `127.0.0.1:${6081 + offset}:6081`, "--publish", `127.0.0.1:${8790 + offset}:8790`,
      "--volume", `${containerName}-workspace:/workspace`, "--volume", `${containerName}-data:/home/box/sand-data`,
      "--mount", `type=bind,src=${hostBundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
      "--mount", `type=bind,src=${dirname(hostBundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
      ...(inferenceFile == null ? [] : ["--mount", `type=bind,src=${dirname(inferenceFile)},dst=/run/grok-bot,readonly`]),
      ...authMounts,
      LOCAL_DOCKER_BOX_IMAGE,
    ]);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token, gatewayUrl)) return { baseUrl: gatewayUrl, token };
    const state = await inspectContainer(containerName);
    if (!state.running) {
      const logs = await runDocker(["logs", "--tail", "80", containerName]);
      throw new Error(`Local Docker VM stopped before its gateway became ready.\n${logs.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Local Docker VM did not expose its gateway within three minutes.");
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureLocalDockerBox(settingsPath);
}

export async function stopLocalDockerBox(): Promise<void> {
  if (localHostProcess && !localHostProcess.killed) {
    try {
      if (process.platform === "win32" && localHostProcess.pid) {
        spawn("taskkill", ["/pid", String(localHostProcess.pid), "/T", "/F"]);
      } else {
        localHostProcess.kill();
      }
    } catch {}
    localHostProcess = null;
  }
  await freeStalePortIfDead(1340);
  await freeStalePortIfDead(1337);
  const inspected = await inspectContainer().catch(() => ({ exists: false, running: false, owned: false }));
  if (!inspected.exists || !inspected.running || !inspected.owned) return;
  await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => undefined);
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = (async () => {
      const issued = remote.issueInferenceCredential == null ? undefined : await Promise.race([
        remote.issueInferenceCredential(),
        new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
      ]).catch(() => undefined);
      return await ensureLocalDockerBox(settings.settingsPath, issued);
    })().finally(() => { ensureInFlight = undefined; });
    return ensureInFlight;
  };
  return {
    connect: async () => settings.getBoxRuntime() === "local-docker" ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      const stopped = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!stopped.ok) throw new Error(`Could not restart the local Docker VM: ${stopped.output}`);
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.forceRecreate == null) return { status: "rejected", reason: "Remote computer reset is unavailable." };
        return await remote.forceRecreate();
      }
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
