import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertSigningConfig, components, isSigningComponent, policy, preflight, requirementFor, signatureDetails, signingIdentifier } from "../scripts/signing.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("release configuration pins the certificate and fails closed", () => {
  assertSigningConfig(pkg.build);
  for (const identity of ["-", null, "Forge Local Code Signing", "0".repeat(40)]) {
    const config = structuredClone(pkg.build); config.mac.identity = identity;
    assert.throws(() => assertSigningConfig(config), /pinned signing certificate/);
  }
  for (const [field, value] of [["forceCodeSigning", false], ["appId", "org.forge.other"], ["productName", "Forge 2"], ["afterSign", null]]) {
    assert.throws(() => assertSigningConfig({ ...pkg.build, [field]: value }));
  }
  assert.equal(pkg.scripts["package:mac"], "node scripts/package-mac.mjs");
  assert.equal(pkg.devDependencies["@electron/osx-sign"], "1.3.3");
});

test("every app, Helper, framework and standalone binary has a stable distinct ID", () => {
  assert.equal(components.length, 14);
  assert.equal(new Set(components.map(component => component.identifier)).size, components.length);
  for (const component of components) {
    assert.equal(signingIdentifier(component.binary), component.identifier);
    if (component.bundle) assert.equal(signingIdentifier(component.bundle), component.identifier);
    assert.doesNotMatch(component.identifier, /55554944|[a-f0-9]{32}/);
  }
  assert.equal(signingIdentifier(""), "org.forge.harness");
  assert.equal(signingIdentifier("Contents/Resources/native/forge-flock"), "org.forge.harness.flock");
  assert.throws(() => signingIdentifier("Contents/Resources/native/unreviewed"), /Unreviewed/);
  assert.throws(() => signingIdentifier("../Other.app"), /Unreviewed/);
});

test("locale data is sealed as resources, not assigned a code identity", () => {
  for (const path of ["Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/af.lproj/locale.pak", "Contents/Resources/app.asar"]) {
    assert.equal(isSigningComponent(path), false);
    assert.throws(() => signingIdentifier(path), /Unreviewed/);
  }
  for (const component of components) {
    assert.equal(isSigningComponent(component.binary), true);
    if (component.bundle) assert.equal(isSigningComponent(component.bundle), true);
  }
});

test("DR pins the certificate and ID, not the build's code hash", () => {
  const identifier = policy.bundleId;
  const requirement = requirementFor(identifier);
  assert.equal(requirement, `identifier "org.forge.harness" and certificate leaf = H"${policy.certificateSha1.toLowerCase()}"`);
  assert.doesNotMatch(requirement, /cdhash|anchor trusted/);
  const details = hash => `Identifier=${identifier}\nCodeDirectory flags=0x10000(runtime)\nAuthority=${policy.commonName}\nCDHash=${hash}\ndesignated => ${requirement}\n`;
  const first = signatureDetails(details("a".repeat(40)), identifier);
  const second = signatureDetails(details("b".repeat(40)), identifier);
  assert.equal(first.requirement, second.requirement);
  assert.notEqual(first.cdhash, second.cdhash);
  assert.throws(() => requirementFor('invalid" or true'), /Unreviewed/);
  assert.throws(() => signatureDetails(details("a".repeat(40)).replace("runtime", "adhoc,runtime"), identifier), /Ad-hoc/);
  assert.throws(() => signatureDetails(details("a".repeat(40)).replace("Identifier=org.forge.harness", "Identifier=org.forge.other"), identifier), /identifier changed/);
  assert.throws(() => signatureDetails(details("a".repeat(40)).replace(policy.certificateSha1.toLowerCase(), "c".repeat(40)), identifier), /requirement changed/);
  assert.throws(() => signatureDetails(details("a".repeat(40)).replace(requirement, 'identifier "org.forge.harness"'), identifier), /requirement changed/);
  assert.throws(() => signatureDetails(details("a".repeat(40)).replace(requirement, `cdhash H"${"a".repeat(40)}"`), identifier), /requirement changed/);
});

test("missing signing keychain never triggers key generation or ad-hoc fallback", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  await assert.rejects(preflight(pkg.build, { FORGE_MAC_SIGNING_KEYCHAIN: "/nonexistent/forge-signing-test.keychain-db" }), /fixed signing keychain is missing/);
});
