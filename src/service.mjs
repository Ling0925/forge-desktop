import { createServer } from "node:http";
import { createHarness } from "@forge/core/core/harness";
import { createRuntimeHub } from "@forge/core/host/runtime";
import { createWebHost } from "@forge/core/web/server";
import { authenticated } from "./security.mjs";

// Bind one ephemeral loopback port, then give Core its exact origin. Core's
// unbound server only handles authenticated WebSocket upgrades; it never opens
// a second (unauthenticated) listener. This also avoids a port-selection race.
export async function startDesktopService({ token, workspace, rendererRoot }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("Invalid instance token");
  let web;
  let runtime;
  let closing;
  const listener = createServer((request, response) => {
    if (!authenticated(request.headers, token)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    if (!web) {
      response.writeHead(503);
      response.end("Starting");
      return;
    }
    void web.handle(request, response, () => {
      response.writeHead(404);
      response.end("Not found");
    }).catch(() => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(500); response.end("Service unavailable"); }
    });
  });
  listener.on("upgrade", (request, socket, head) => {
    if (!web || !authenticated(request.headers, token) || request.url?.split("?")[0] !== "/api/events") {
      socket.destroy();
      return;
    }
    web.server.emit("upgrade", request, socket, head);
  });
  const close = () => closing ??= (async () => {
    try {
      await web?.close();
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(() => resolve()));
    } finally { await runtime?.dispose(); }
  })();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const port = listener.address().port;
    runtime = createRuntimeHub(await createHarness());
    web = await createWebHost({ runtime, workspace, host: "127.0.0.1", port,
      restrictWorkspace: false, rendererRoot });
    return { origin: web.origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
