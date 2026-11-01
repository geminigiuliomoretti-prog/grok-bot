import { build } from "esbuild";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const outfileA = join(tmpdir(), "dual-router-bundle.mjs");
  await build({
    entryPoints: ["tests/dual-router.test.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outfileA,
    packages: "external",
  });

  const outfileB = join(tmpdir(), "gemini-native-bundle.mjs");
  await build({
    entryPoints: ["tests/gemini-native-adapter.test.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outfileB,
    packages: "external",
  });

  console.log("Running Dual-Engine test suite with node --test...");
  const outputA = execSync(`node --test "${outfileA}"`, { encoding: "utf8" });
  console.log(outputA);

  console.log("Running Gemini-Native test suite with node --test...");
  const outputB = execSync(`node --test "${outfileB}"`, { encoding: "utf8" });
  console.log(outputB);
}

main().catch((err) => {
  console.error("Test execution failed:", err.stdout || err.message);
  process.exit(1);
});
