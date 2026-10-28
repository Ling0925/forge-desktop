import { timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-forge-desktop-token";

export function authenticated(headers, token) {
  const supplied = headers[TOKEN_HEADER];
  if (typeof supplied !== "string") return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function internalUrl(value, origin) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "ws:") url.protocol = "http:";
    return url.origin === origin;
  } catch { return false; }
}

export function externalUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
