import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";

/**
 * Commissioner auth (SPEC §12.2): one password from the environment, a signed
 * cookie, nothing else. Public pages need no auth at all.
 */
export const COOKIE_NAME = "league_commissioner";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function sign(payload: string): string {
  return createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function issueCookieValue(now: Date): string {
  const expires = String(now.getTime() + MAX_AGE_SECONDS * 1000);
  return `${expires}.${sign(expires)}`;
}

export function verifyCookieValue(value: string | undefined, now: Date): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const expires = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!safeEqual(signature, sign(expires))) return false;
  const expiresAt = Number(expires);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/** Constant-time password check against COMMISSIONER_PASSWORD. */
export function passwordMatches(candidate: string): boolean {
  return safeEqual(candidate, env.commissionerPassword);
}

/** True when the current request carries a valid commissioner cookie. */
export async function isCommissioner(): Promise<boolean> {
  // Next 16: cookies() is async.
  const jar = await cookies();
  return verifyCookieValue(jar.get(COOKIE_NAME)?.value, new Date());
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE_SECONDS,
};
