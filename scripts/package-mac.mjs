import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, signApp, verifyApp } from "./signing.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// Fail before building if the fixed keychain is absent. Never create a key or
// accept an ad-hoc substitute in the packaging path.
const keychain = await preflight(pkg.build);
const { build, Platform, Arch } = await import("electron-builder");
const output = resolve(root, pkg.build.directories.output);
const temporaryBase = resolve(process.env.FORGE_DESKTOP_PACKAGE_TMP || join(root, "../../.forge/tmp/desktop-package"));
await mkdir(temporaryBase, { recursive: true });
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(temporaryBase, "run-"));
const artifactName = `Forge-${pkg.version}-arm64.dmg`;
const artifact = join(output, artifactName);
const reportFile = join(output, `Forge-${pkg.version}-arm64.signing.json`);
let packagingStarted = false;
try {
  // Only an unsigned staging .app is produced here, never a distributable DMG.
  // Local certificates are deliberately not added to the system trust store.
  await build({
    projectDir: root, targets: Platform.MAC.createTarget(["dir"], Arch.arm64), publish: "never",
    config: { ...pkg.build, directories: { ...pkg.build.directories, output: temporary },
      forceCodeSigning: false, beforePack: null, afterSign: null, mac: { ...pkg.build.mac, identity: null } },
  });
  const stagedApp = join(temporary, "mac-arm64/Forge.app");
  const signed = await signApp(stagedApp, keychain, temporary);
  // No partial/unsigned application becomes the release app. The old release
  // remains untouched until its replacement has passed identity verification.
  const application = join(output, "mac-arm64/Forge.app");
  await mkdir(join(output, "mac-arm64"), { recursive: true });
  await rm(application, { recursive: true, force: true });
  await rename(stagedApp, application);
  packagingStarted = true;
  // Remove stale same-version artifacts so a failure cannot leave an old DMG
  // masquerading as the output of this signing run.
  await rm(artifact, { force: true });
  await rm(`${artifact}.blockmap`, { force: true });
  await rm(reportFile, { force: true });
  await build({
    projectDir: root, prepackaged: application,
    targets: Platform.MAC.createTarget(["dmg"], Arch.arm64), publish: "never",
    config: pkg.build,
  });
  assert.deepEqual(await verifyApp(application, temporary), signed, "Packaging changed the verified application");
  execFileSync("/usr/bin/hdiutil", ["verify", artifact], { stdio: "inherit" });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  await writeFile(reportFile, JSON.stringify({
    artifact: artifactName, sha256: hash.digest("hex"), verifiedAt: new Date().toISOString(),
    ...signed,
  }, null, 2) + "\n");
  console.log(`Fixed-identity package verified: ${artifact}\nSigning receipt: ${reportFile}`);
} catch (error) {
  // Preserve an earlier release if failure happened before starting its replacement.
  if (packagingStarted) {
    await rm(artifact, { force: true });
    await rm(`${artifact}.blockmap`, { force: true });
    await rm(reportFile, { force: true });
  }
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
