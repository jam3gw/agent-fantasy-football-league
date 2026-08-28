/**
 * Admin protection and public cache headers (SPEC §12.1, §12.2, §15.5).
 *
 * Next 16 renamed `middleware` to `proxy`; the export is `proxy` and the
 * runtime is Node (not configurable), which suits us because the signature
 * check uses node:crypto.
 */
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifyCookieValue } from "./lib/auth";

/**
 * §12.1's freshness windows. Pages render per request (they show live,
 * time-dependent state), so the CDN holds them for this long and serves the
 * stale copy while it refreshes — the same behaviour ISR would give, without
 * making a deploy depend on the database.
 */
const LIVE_PAGES = [/^\/$/, /^\/matchups(\/|$)/, /^\/draft(\/|$)/];
const LIVE_SECONDS = 30;
const DEFAULT_SECONDS = 300;

function cacheHeader(pathname: string): string {
  const seconds = LIVE_PAGES.some((r) => r.test(pathname)) ? LIVE_SECONDS : DEFAULT_SECONDS;
  return `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`;
}

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (!isAdminPath(pathname)) {
    const response = NextResponse.next();
    // The draft state API sets its own no-store; never cache a mutation.
    if (request.method === "GET" && !pathname.startsWith("/api/draft/")) {
      response.headers.set("Cache-Control", cacheHeader(pathname));
    }
    return response;
  }

  // The login page and its action must stay reachable.
  if (pathname === "/admin/login" || pathname === "/api/admin/login") return NextResponse.next();

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (verifyCookieValue(cookie, new Date())) {
    const response = NextResponse.next();
    // Nothing behind the commissioner login is ever cached.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", message: "Commissioner login required." },
      { status: 401 },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = "/admin/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets, so public pages get cache headers and
  // admin routes get the auth check.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
