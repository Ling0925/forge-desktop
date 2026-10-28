import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { startDesktopService } from "../src/service.mjs";
import { TOKEN_HEADER } from "../src/security.mjs";

const temporaryRoot = resolve(process.env.FORGE_DESKTOP_TEST_DIR ?? "../../.forge/tmp/desktop-unit");
test("loopback service serves current Core/Web, gates HTTP and WS, and shuts down", async t => {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, "service-"));
  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const rendererRoot = join(root, "renderer");
  await mkdir(rendererRoot);
  await writeFile(join(rendererRoot, "index.html"), "<!doctype html><title>Fixture</title><main>Current Web</main>");
  const token = "b".repeat(64);
  const service = await startDesktopService({ token, workspace: root, rendererRoot });
  t.after(() => service.close());
  assert.match(service.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(service.origin)).status, 403);
  assert.equal((await fetch(`${service.origin}/api/version`, { headers: { [TOKEN_HEADER]: "bad" } })).status, 403);
  const headers = { [TOKEN_HEADER]: token };
  const html = await fetch(service.origin, { headers });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Current Web/);
  const version = await fetch(`${service.origin}/api/version`, { headers });
  assert.equal(version.status, 200);
  assert.ok(await version.json());
  const spoofed = await fetch(`${service.origin}/api/version`, { headers: { ...headers, Origin: "https://evil.test" } });
  assert.equal(spoofed.status, 403);
  await new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(service.origin).port), "127.0.0.1");
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Unauthenticated upgrade stayed open")); }, 2000);
    socket.on("error", reject);
    socket.on("data", () => reject(new Error("Unauthenticated upgrade received data")));
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.once("connect", () => socket.write(`GET /api/events HTTP/1.1\r\nHost: ${new URL(service.origin).host}\r\nOrigin: ${service.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  });
  await service.close();
  await assert.rejects(fetch(service.origin));
});
