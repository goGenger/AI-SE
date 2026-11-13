// 认证与令牌：scrypt 口令哈希 + HMAC-SHA256 签名令牌（密钥持久化于 DATA_DIR/.secret）。
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

export function loadTokenSecret(dataDir) {
  if (process.env.TOKEN_SECRET) {
    return process.env.TOKEN_SECRET;
  }
  const file = join(dataDir, ".secret");
  if (existsSync(file)) {
    return readFileSync(file, "utf8").trim();
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret);
  return secret;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function issueToken(secret, userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Date.now() })).toString(
    "base64url"
  );
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyToken(secret, token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url");
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload : null;
  } catch {
    return null;
  }
}
