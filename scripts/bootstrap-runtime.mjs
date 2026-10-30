import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  archivedDmg,
  archivedSetupExe,
  cachedDmg,
  cachedRuntimeApp,
  cachedRuntimeWin,
  cachedSetupExe,
  dmgSha256,
  dmgUrl,
  setupExeSha256,
  setupExeUrl,
} from "./lib/config.mjs";
import { run } from "./lib/process.mjs";
import { cacheRuntimeFromApp, hydrateSourcePayloadFromAsar, hydrateSourcePayloadFromRuntime, validateRuntimeApp } from "./lib/runtime.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";


async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadSetupExe() {
  await mkdir(path.dirname(cachedSetupExe), { recursive: true });
  if (await exists(cachedSetupExe)) {
    const digest = await sha256(cachedSetupExe);
    if (digest === setupExeSha256) return;
    await rm(cachedSetupExe, { force: true });
  }

  if (await exists(archivedSetupExe)) {
    const archivedDigest = await sha256(archivedSetupExe);
    if (archivedDigest !== setupExeSha256) {
      throw new Error(`Archived Setup.exe checksum mismatch: expected ${setupExeSha256}, got ${archivedDigest}. Run git lfs pull before bootstrapping.`);
    }
    console.log(`Using archived release ${archivedSetupExe}`);
    await copyFile(archivedSetupExe, cachedSetupExe);
    return;
  }

  console.log(`Downloading ${setupExeUrl}`);
  const response = await fetch(setupExeUrl, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${cachedSetupExe}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  const digest = await sha256(partial);
  if (digest !== setupExeSha256) {
    await rm(partial, { force: true });
    throw new Error(`Setup.exe checksum mismatch: expected ${setupExeSha256}, got ${digest}`);
  }
  await rename(partial, cachedSetupExe);
}

async function extractWindowsRuntime() {
  await mkdir(cachedRuntimeWin, { recursive: true });
  const tempExtract = await mkdtemp(path.join(tmpdir(), "grok-bot-win-extract-"));
  try {
    console.log("Extracting Windows installer via 7z...");
    await run(SYSTEM_TOOLS.sevenZip, ["e", cachedSetupExe, `-o${tempExtract}`, "$PLUGINSDIR\\app-64.7z", "-y"]);
    const app7z = path.join(tempExtract, "app-64.7z");
    console.log("Extracting full Windows runtime files from app-64.7z...");
    await run(SYSTEM_TOOLS.sevenZip, ["x", app7z, `-o${cachedRuntimeWin}`, "-y"]);
  } finally {
    await rm(tempExtract, { recursive: true, force: true });
  }
}

async function extractMacDmgAsar() {
  // On Windows, 7z can extract app.asar directly from DMG
  const macDmg = (await exists(cachedDmg)) ? cachedDmg : archivedDmg;
  const tempExtract = await mkdtemp(path.join(tmpdir(), "grok-bot-mac-extract-"));
  try {
    console.log("Extracting app.asar from macOS DMG via 7z...");
    await run(SYSTEM_TOOLS.sevenZip, ["x", macDmg, `-o${tempExtract}`, "Grok Bot.app\\Contents\\Resources\\app.asar*", "-r", "-y"]);
    const asarPath = path.join(tempExtract, "Grok Bot.app", "Contents", "Resources", "app.asar");
    return await hydrateSourcePayloadFromAsar(asarPath);
  } finally {
    await rm(tempExtract, { recursive: true, force: true });
  }
}


let runtimeApp;
let hydrated;

if (process.platform === "win32") {
  const configuredApp = process.env.GROK_BOT_018_APP?.trim();
  if (configuredApp) {
    runtimeApp = await validateRuntimeApp(path.resolve(configuredApp));
  } else if (await exists(cachedRuntimeWin)) {
    runtimeApp = await validateRuntimeApp(cachedRuntimeWin);
  } else {
    await downloadSetupExe();
    await extractWindowsRuntime();
    runtimeApp = await validateRuntimeApp(cachedRuntimeWin);
  }

  // Extract source payload app.asar from macOS DMG or use Windows asar with unpacked
  hydrated = await extractMacDmgAsar();
  console.log(`Windows runtime ready: ${cachedRuntimeWin}`);
  console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
} else {
  const configuredApp = process.env.GROK_BOT_018_APP?.trim();
  if (configuredApp) {
    runtimeApp = await cacheRuntimeFromApp(configuredApp);
  } else if (await exists(cachedRuntimeApp)) {
    runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
  } else {
    await downloadDmg();
    await extractRuntime();
    runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
  }

  hydrated = await hydrateSourcePayloadFromRuntime(runtimeApp);
  console.log(`Runtime ready: ${cachedRuntimeApp}`);
  console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
}

console.log("The checksum-pinned app supplies only the Electron shell, ABI-matched native dependencies, and explicitly documented build fallbacks.");
