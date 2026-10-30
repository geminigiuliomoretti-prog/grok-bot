import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  cachedRuntimeWin,
  outputDir,
} from "./lib/config.mjs";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { resolveRuntimeApp } from "./lib/runtime.mjs";

if (process.platform !== "win32") {
  throw new Error("scripts/package-windows.mjs can only be run on Windows.");
}

const packageOutputWinDir = path.join(outputDir, "win-unpacked-onboarding-fix-20261030");

console.log("Building Fidelity Reconstructed ASAR with original renderer for Windows...");
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();
const runtimeDir = await resolveRuntimeApp();

console.log(`Packaging Windows app into ${packageOutputWinDir}...`);
await mkdir(outputDir, { recursive: true });
await rm(packageOutputWinDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
await cp(runtimeDir, packageOutputWinDir, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
});

const resources = path.join(packageOutputWinDir, "resources");
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

console.log(`Windows packaged distribution successfully created at:\n${path.join(packageOutputWinDir, "Grok Bot.exe")}`);
