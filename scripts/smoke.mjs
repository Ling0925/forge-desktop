import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
const base = resolve(process.env.FORGE_DESKTOP_TEST_DIR ?? join(moduleRoot, "../../.forge/tmp/desktop-smoke"));
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(join(base, "run-"));
const workspace = join(temporary, "project with spaces");
await mkdir(workspace);
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temporary,
  TMPDIR: temporary, LANG: "en_US.UTF-8",
  FORGE_HOME: join(temporary, "state"), FORGE_WORKSPACE: workspace,
  FORGE_DESKTOP_USER_DATA: join(temporary, "profile"),
  ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
};
let app;
let serviceOrigin;
const errors = [];
let diagnostic = "";
const executablePath = process.env.FORGE_DESKTOP_EXECUTABLE;
let providerCalls = 0;
// Only an isolated loopback catalog fixture; never use a real provider/key.
const modelService = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "fixture/model" }] }));
  } else {
    providerCalls++;
    response.writeHead(501).end(JSON.stringify({ error: "Inference is not part of this smoke test" }));
  }
});
async function launch(hasService = false) {
  const application = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [moduleRoot] }), env, timeout: 45000 });
  app = application; // Retain ownership even when startup/first-window checks fail.
  application.process().stderr?.on("data", data => { diagnostic = (diagnostic + data).slice(-8000); });
  const page = await application.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => !!window.forge);
  await page.locator("body > [role=status]").waitFor({ state: "hidden" });
  // Only a genuinely empty setup opens settings; a source needs no default model.
  if (!hasService) await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await page.getByRole("button", { name: hasService ? "模型服务已添加" : "添加模型服务", exact: true }).waitFor();
  await page.locator(".composer-textarea").waitFor();
  assert.equal(await page.getByRole("button", { name: "展开详情", exact: true }).getAttribute("aria-expanded"), "false");
  return { application, page };
}
try {
  let started = await launch();
  app = started.application;
  let page = started.page;
  serviceOrigin = new URL(page.url()).origin;
  assert.equal(await page.title(), "Forge");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert.ok(csp.includes(`connect-src 'self' ${serviceOrigin.replace("http:", "ws:")};`));
  assert.equal((await fetch(serviceOrigin)).status, 403, "other local clients must not reach Core");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined");
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(await page.evaluate(() => window.forge.restrictWorkspace), false);
  assert.deepEqual(await page.evaluate(() => window.forge.listSessions()), []);
  await page.getByRole("button", { name: "选择工作区", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择服务器工作区" });
  await picker.waitFor();
  await picker.getByRole("button", { name: "选择此目录", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
  await page.getByRole("button", { name: "返回工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  const session = await page.evaluate(workspace => window.forge.createSession({ workspace, title: "Desktop smoke", model: "offline-unconfigured" }), workspace);
  assert.ok(session.id);
  await page.reload();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await page.locator(".welcome-task").filter({ hasText: "Desktop smoke" }).click();
  await page.locator(".composer-textarea").fill("Smoke draft — no provider request");
  assert.equal(await page.locator(".composer-textarea").inputValue(), "Smoke draft — no provider request");
  await page.screenshot({ path: join(base, "desktop.png") });
  // Cover actual blob downloads without opening a modal save dialog.
  const downloaded = join(temporary, "download.txt");
  await app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_event, item) => item.setSavePath(path));
  }, downloaded);
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["Forge desktop download"]));
    link.download = "download.txt";
    document.body.append(link); link.click(); link.remove();
  });
  for (let attempt = 0; ; attempt++) {
    if (await readFile(downloaded, "utf8").catch(() => "") === "Forge desktop download") break;
    if (attempt >= 100) throw new Error("Blob download did not finish");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => modelService.listen(0, "127.0.0.1", resolve));
  const modelOrigin = `http://127.0.0.1:${modelService.address().port}/v1`;
  const sourceSession = await page.evaluate(async ({ workspace, baseUrl }) => {
    const settings = await window.forge.updateSettings({ source: { type: "save", source: {
      id: "smoke-source", label: "Smoke local source", baseUrl, model: "",
      modelSelection: { mode: "all", models: ["fixture/model"] },
    } } });
    if (settings.isConfigured) throw new Error("Fixture must reproduce an unset global default model");
    return window.forge.createSession({ workspace, title: "Model service smoke", model: "fixture/model", providerSourceId: "smoke-source" });
  }, { workspace, baseUrl: modelOrigin });
  await page.reload();
  await page.getByRole("button", { name: "模型服务已添加", exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "设置工作区" }).count(), 0);
  await page.locator(".session-item-main").filter({ hasText: "Model service smoke" }).click();
  // The real HTTP snapshot hydrates after navigation; do not assert against
  // the intermediate render that still has no session-bound source/model.
  await page.getByRole("heading", { name: "Model service smoke", exact: true }).waitFor();
  await page.locator(".composer-textarea").fill("Session-bound model without a global default");
  await page.locator(".composer-run:not(:disabled)").waitFor();
  assert.equal(await page.getByRole("button", { name: "运行", exact: true }).isEnabled(), true);
  const statusHint = await page.locator(".sidebar-model-status").getAttribute("title");
  assert.ok(statusHint.includes("不是网络连接状态"));
  const footerFits = await page.locator(".sidebar-footer").evaluate(footer =>
    footer.scrollWidth <= footer.clientWidth + 1 && [...footer.querySelectorAll("button span")].every(label => {
      const range = document.createRange(); range.selectNodeContents(label);
      return range.getClientRects().length === 1 && label.scrollWidth <= label.clientWidth + 1;
    }));
  assert.equal(footerFits, true);
  await page.getByRole("button", { name: "展开详情", exact: true }).click();
  await page.getByRole("tab", { name: "计划与进度", exact: true }).waitFor();
  await page.locator(".wb-inspector-close").click();
  await page.screenshot({ path: join(base, "desktop-model-service.png"), animations: "disabled" });
  const versions = await app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node, arch: process.arch }));
  await app.close(); app = undefined;
  await assert.rejects(fetch(serviceOrigin), "Core listener must stop when the app quits");
  started = await launch(true); app = started.application; page = started.page;
  const bound = await page.evaluate(id => window.forge.getSession(id), sourceSession.id);
  assert.equal(bound.providerSourceId, "smoke-source");
  assert.equal(bound.model, "fixture/model");
  assert.equal(providerCalls, 0);
  const restored = await page.evaluate(id => window.forge.getSession(id), session.id);
  assert.equal(restored.id, session.id);
  assert.equal(restored.workspace, workspace);
  assert.deepEqual(errors, []);
  const report = { ok: true, versions, packaged: Boolean(executablePath), checks: [
    "sandboxed Electron render", "Core HTTP + WebSocket connection", "instance token rejection",
    "workspace picker", "lazy settings navigation", "session create/read", "composer interaction",
    "blob download", "clean shutdown", "session persisted across restart",
    "model source without a global default", "single-line sidebar footer", "collapsed details navigation",
  ], providerCalls, screenshot: "desktop-model-service.png" };
  await writeFile(join(base, "smoke-result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(diagnostic);
  if (app) {
    const page = app.windows()[0];
    if (page) {
      await page.screenshot({ path: join(base, "failure.png") }).catch(() => {});
      console.error((await page.locator("body").innerText().catch(() => "")).slice(0, 5000));
    }
  }
  throw error;
} finally {
  await app?.close();
  if (modelService.listening) await new Promise(resolve => modelService.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
