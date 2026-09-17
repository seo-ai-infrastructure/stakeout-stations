import { createHmac, timingSafeEqual } from "node:crypto";
export function signCapture(runId: string, secret: string, now = Date.now()) {
  const body = Buffer.from(
    JSON.stringify({ runId, exp: Math.floor(now / 1000) + 21600 }),
  ).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function verifyCapture(
  token: string,
  secret: string,
  now = Date.now(),
): string | null {
  try {
    if (token.length > 1024 || !secret || secret.length < 32) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const expected = createHmac("sha256", secret).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return null;
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    return typeof p.runId === "string" &&
      /^[0-9a-f-]{36}$/i.test(p.runId) &&
      Number.isInteger(p.exp) &&
      p.exp > now / 1000
      ? p.runId
      : null;
  } catch {
    return null;
  }
}
