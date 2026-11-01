import { build } from "esbuild";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const outfile = join(tmpdir(), "dual-router-bundle.mjs");
  await build({
    entryPoints: ["tests/dual-router.test.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    packages: "external",
  });

  console.log("Running Dual-Engine test suite with node --test...");
  const output = execSync(`node --test "${outfile}"`, { encoding: "utf8" });
  console.log(output);
}

main().catch((err) => {
  console.error("Test execution failed:", err.stdout || err.message);
  process.exit(1);
});
