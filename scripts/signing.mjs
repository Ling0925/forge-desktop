import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { access, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Public metadata only. The corresponding private key stays in the Mac keychain.
export const policy = Object.freeze(JSON.parse(readFileSync(new URL("../signing-policy.json", import.meta.url), "utf8")));
assert.match(policy.certificateSha1, /^[A-F0-9]{40}$/);
assert.match(policy.certificateSha256, /^[A-F0-9]{64}$/);

export const components = [
  { binary: "Contents/MacOS/Forge", bundle: ".", identifier: policy.bundleId },
  { binary: "Contents/Resources/native/forge-flock", identifier: `${policy.bundleId}.flock` },
  ...["", "GPU", "Plugin", "Renderer"].map(kind => {
    const name = `Forge Helper${kind ? ` (${kind})` : ""}`;
    const bundle = `Contents/Frameworks/${name}.app`;
    return { bundle, binary: `${bundle}/Contents/MacOS/${name}`, identifier: `${policy.bundleId}.helper${kind ? `.${kind}` : ""}` };
  }),
  ...[
    ["Electron Framework", "com.github.Electron.framework"],
    ["Mantle", "com.electron.mantle"],
    ["ReactiveObjC", "com.electron.reactive"],
    ["Squirrel", "com.github.Squirrel"],
  ].map(([name, identifier]) => {
    const bundle = `Contents/Frameworks/${name}.framework`;
    return { bundle, binary: `${bundle}/Versions/A/${name}`, identifier };
  }),
  { binary: "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib", identifier: "com.github.Electron.ffmpeg" },
  { binary: "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib", identifier: "com.github.Electron.vk_swiftshader" },
  { binary: "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler", identifier: "com.github.Electron.crashpad" },
  { binary: "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt", identifier: "com.github.Squirrel.ShipIt" },
];
const identifiers = new Map(components.flatMap(component => [
  [component.binary, component.identifier],
  ...(component.bundle ? [[component.bundle, component.identifier]] : []),
]));

export function isSigningComponent(path) {
  return identifiers.has(posix.normalize(path || "."));
}
export function signingIdentifier(path) {
  const identifier = identifiers.get(posix.normalize(path || "."));
  if (!identifier) throw new Error(`Unreviewed signing component: ${path}`);
  return identifier;
}
export function requirementFor(identifier) {
  assert.ok(components.some(component => component.identifier === identifier), "Unreviewed signing identifier");
  // Do not use a cdhash or an identifier-only requirement. Every version must
  // prove possession of the same certificate's private key as well as its ID.
  return `identifier "${identifier}" and certificate leaf = H"${policy.certificateSha1.toLowerCase()}"`;
}
export function assertSigningConfig(config) {
  assert.equal(config.appId, policy.bundleId, "The application identity must not change");
  assert.equal(config.productName, "Forge", "Keep the application and Helper names stable");
  assert.equal(config.mac?.identity, policy.certificateSha1, "The pinned signing certificate is required; ad-hoc is forbidden");
  assert.equal(config.forceCodeSigning, true, "Signing must fail closed");
  assert.equal(config.afterSign, "./scripts/signing.mjs", "Post-sign identity verification is required");
}
export function signingKeychain(env = process.env) {
  return resolve(env.FORGE_MAC_SIGNING_KEYCHAIN || join(homedir(), "Library/Keychains", policy.keychainFile));
}
export async function preflight(config, env = process.env) {
  assertSigningConfig(config);
  assert.equal(process.platform, "darwin", "macOS packaging requires a Mac");
  assert.equal(process.arch, "arm64", "This package targets Apple Silicon");
  const keychain = signingKeychain(env);
  await access(keychain).catch(() => {
    throw new Error(`The fixed signing keychain is missing: ${keychain}. Restore it; do not generate a replacement identity.`);
  });
  return keychain;
}
export async function beforePack(context) {
  // The documented package script signs explicitly. Direct electron-builder
  // invocations also must not silently select another identity or fall back.
  process.env.CSC_KEYCHAIN = await preflight(context.packager.config);
}

function codesign(args) {
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return `${result.stdout}\n${result.stderr}`;
}
export function signatureDetails(text, identifier) {
  assert.doesNotMatch(text, /\badhoc\b|Signature=adhoc/, "Ad-hoc signatures are not release identities");
  assert.equal(text.match(/^Identifier=(.+)$/m)?.[1], identifier, "Signing identifier changed");
  const requirement = text.match(/^(?:# )?designated => (.+)$/m)?.[1]
    ?.replace(/H"([a-fA-F0-9]+)"/g, (_, hash) => `H"${hash.toLowerCase()}"`);
  assert.equal(requirement, requirementFor(identifier), "Designated requirement changed");
  const cdhash = text.match(/^CDHash=([a-fA-F0-9]{40})$/m)?.[1];
  assert.ok(cdhash, "Missing CodeDirectory hash");
  return { identifier, requirement, cdhash };
}

const machOMagic = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
async function binaries(directory, root = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await binaries(path, root));
    else if (entry.isFile()) {
      const file = await open(path, "r");
      try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await file.read(header, 0, 4, 0);
        if (bytesRead === 4 && machOMagic.has(header.toString("hex"))) result.push(relative(root, path));
      } finally { await file.close(); }
    }
  }
  return result;
}
async function assertComponentSet(app) {
  assert.deepEqual((await binaries(app)).sort(), components.map(component => component.binary).sort(), "Packaged native component set changed; review its stable identity");
}
export async function verifyApp(app, temporaryBase) {
  codesign(["--verify", "--deep", "--strict", app]);
  await assertComponentSet(app);
  const temporary = await mkdtemp(join(temporaryBase, "certificate-check-"));
  try {
    codesign(["--display", `--extract-certificates=${join(temporary, "certificate")}`, app]);
    const certificate = new X509Certificate(await readFile(join(temporary, "certificate0")));
    assert.equal(certificate.fingerprint256.replaceAll(":", ""), policy.certificateSha256, "The release certificate changed");
    const signed = components.map(component => {
      const path = join(app, component.binary);
      const details = signatureDetails(codesign(["--display", "--verbose=4", "-r-", path]), component.identifier);
      codesign(["--verify", "--strict", "-R", `=${details.requirement}`, path]);
      return { binary: component.binary, ...details };
    });
    return { certificateSha1: policy.certificateSha1, certificateSha256: policy.certificateSha256, components: signed };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function signApp(app, keychain, temporaryBase) {
  const { signAsync } = await import("@electron/osx-sign");
  const canonicalApp = realpathSync(app);
  await assertComponentSet(app);
  await signAsync({
    app, keychain, identity: policy.certificateSha1,
    // osx-sign's generic binary detection also selects locale .pak data. Those
    // belong in the enclosing resource seal, not separate code signatures.
    // The Mach-O set was checked above, so new code cannot be silently skipped.
    // Pass one predicate: osx-sign 1.3.3 drops an array in validateOptsIgnore.
    ignore: file => !isSigningComponent(relative(canonicalApp, realpathSync(file))),
    // A local certificate need not be a system-trusted Developer ID. Select it
    // by exact fingerprint, then verify its signature, certificate and DR below.
    identityValidation: false,
    platform: "darwin", type: "distribution", strictVerify: true,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile(file) {
      const identifier = signingIdentifier(relative(canonicalApp, realpathSync(file)));
      return {
        entitlements: fileURLToPath(new URL("../assets/entitlements.mac.plist", import.meta.url)),
        hardenedRuntime: true, timestamp: "none",
        requirements: `=designated => ${requirementFor(identifier)}`,
        additionalArguments: ["--identifier", identifier],
      };
    },
  });
  return verifyApp(app, temporaryBase);
}
export async function afterSign(context) {
  await verifyApp(join(context.appOutDir, "Forge.app"), context.outDir);
}
