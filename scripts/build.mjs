import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const core = dirname(require.resolve("@forge/core/package.json"));
const web = resolve(root, "../forge-web-ui");
const renderer = process.env.FORGE_RENDERER_DIR ? resolve(process.env.FORGE_RENDERER_DIR) : join(web, "dist/renderer");
const coreBuild = JSON.parse(await readFile(join(core, "dist/build-info.json"), "utf8"));
await readFile(join(renderer, "index.html"));
await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist/runtime"), { recursive: true });
const common = { bundle: true, platform: "node", target: "node22", format: "esm",
  legalComments: "eof", logLevel: "info", sourcemap: false };
await build({ ...common, entryPoints: [join(root, "src/main.mjs")], outfile: join(root, "dist/main.mjs"), external: ["electron"] });
await build({ ...common, entryPoints: [join(root, "src/worker.mjs")], outfile: join(root, "dist/runtime/worker.mjs"),
  // SDKs contain CommonJS Node built-ins. ESM needs an explicit require shim.
  banner: { js: 'import { createRequire as __forgeCreateRequire } from "node:module"; const require = __forgeCreateRequire(import.meta.url);' },
  external: ["bufferutil", "utf-8-validate"] });
await cp(renderer, join(root, "dist/renderer"), { recursive: true });
await mkdir(join(root, "dist/native"));
if (process.platform === "darwin") await cp(join(core, "dist/native/forge-flock"), join(root, "dist/native/forge-flock"));
await cp(join(core, "dist/build-info.json"), join(root, "dist/build-info.json"));
await cp(join(core, "THIRD_PARTY_NOTICES.md"), join(root, "dist/THIRD_PARTY_NOTICES.md"));
function revision(directory) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unknown"; }
}
await writeFile(join(root, "dist/versions.json"), JSON.stringify({
  desktop: revision(root), core: revision(core), web: revision(web), coreBuild,
  electron: require("electron/package.json").version, builtAt: new Date().toISOString(),
}, null, 2) + "\n");
