/**
 * Admin protection (SPEC §12.2, §15.5). Public cache windows live in
 * next.config's headers().
 *
 * Next 16 renamed `middleware` to `proxy`; the export is `proxy` and the
 * runtime is Node (not configurable), which suits us because the signature
 * check uses node:crypto.
 */
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifyCookieValue } from "./lib/auth";

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Public paths pass straight through. Their cache windows (§12.1) are set
  // in next.config's headers(), because a page's own Cache-Control overrides
  // anything set here.
  if (!isAdminPath(pathname)) return NextResponse.next();

  // The login page and its action must stay reachable.
  if (pathname === "/admin/login" || pathname === "/api/admin/login") return NextResponse.next();

  // Without a signing key nobody can be authenticated, so a configuration
  // error is a failed check, not a 500 on every admin path. The login page
  // names the missing variable.
  let authenticated = false;
  try {
    authenticated = verifyCookieValue(request.cookies.get(COOKIE_NAME)?.value, new Date());
  } catch {
    authenticated = false;
  }
  if (authenticated) return NextResponse.next();

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
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
