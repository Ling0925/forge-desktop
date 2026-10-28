import assert from "node:assert/strict";
import test from "node:test";
import { authenticated, externalUrl, internalUrl, TOKEN_HEADER } from "../src/security.mjs";

test("instance authentication rejects missing, malformed and different tokens", () => {
  const token = "a".repeat(64);
  assert.equal(authenticated({}, token), false);
  assert.equal(authenticated({ [TOKEN_HEADER]: [token] }, token), false);
  assert.equal(authenticated({ [TOKEN_HEADER]: "b".repeat(64) }, token), false);
  assert.equal(authenticated({ [TOKEN_HEADER]: "a" }, token), false);
  assert.equal(authenticated({ [TOKEN_HEADER]: token }, token), true);
});
test("only the instance HTTP and WebSocket origins are internal", () => {
  const origin = "http://127.0.0.1:4321";
  for (const url of [origin, `${origin}/api/connect`, "ws://127.0.0.1:4321/api/events"]) {
    assert.equal(internalUrl(url, origin), true, url);
  }
  for (const url of ["http://127.0.0.1:4322", "http://localhost:4321", "http://127.0.0.1.evil.test:4321", "file:///etc/passwd", "http://user@127.0.0.1:4321", "invalid"]) {
    assert.equal(internalUrl(url, origin), false, url);
  }
});
test("OS external opening accepts credential-free HTTP(S), never file or custom schemes", () => {
  assert.equal(externalUrl("https://example.com/docs"), true);
  assert.equal(externalUrl("http://localhost:5173"), true);
  for (const url of ["file:///tmp/a", "javascript:alert(1)", "ssh://example.com", "https://user:pass@example.com", "not a URL"]) {
    assert.equal(externalUrl(url), false, url);
  }
});
