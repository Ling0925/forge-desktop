import { startDesktopService } from "./service.mjs";

let service;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await service?.close(); process.exit(0); }
  catch { process.exit(1); }
}
process.parentPort.once("message", async ({ data }) => {
  try {
    service = await startDesktopService(data);
    if (stopping) { await service.close(); return; }
    process.parentPort.postMessage({ kind: "ready", origin: service.origin });
    process.parentPort.on("message", ({ data: message }) => {
      if (message?.kind === "shutdown") void stop();
    });
  } catch (error) {
    // Never include configuration, request headers or environment in diagnostics.
    console.error("Forge Core startup failed:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }
});
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
