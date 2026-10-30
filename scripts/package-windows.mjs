import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  cachedRuntimeWin,
  outputDir,
  outputWinDir,
} from "./lib/config.mjs";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { resolveRuntimeApp } from "./lib/runtime.mjs";

if (process.platform !== "win32") {
  throw new Error("scripts/package-windows.mjs can only be run on Windows.");
}

console.log("Building Fidelity Reconstructed ASAR for Windows...");
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();
const runtimeDir = await resolveRuntimeApp();

console.log(`Packaging Windows app into ${outputWinDir}...`);
await mkdir(outputDir, { recursive: true });
try {
  await rm(outputWinDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch {}
await cp(runtimeDir, outputWinDir, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
});

const resources = path.join(outputWinDir, "resources");
const packagedAsar = path.join(resources, "app.asar");
const packagedUnpacked = `${packagedAsar}.unpacked`;

await rm(packagedAsar, { force: true });
await rm(packagedUnpacked, { recursive: true, force: true });

await cp(builtAsar, packagedAsar);
await cp(builtAsarUnpacked, packagedUnpacked, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
});

console.log(`Windows packaged distribution successfully created at:\n${path.join(outputWinDir, "Grok Bot.exe")}`);
