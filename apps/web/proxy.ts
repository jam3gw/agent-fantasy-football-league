/**
 * Admin route protection (SPEC §12.2, §15.5).
 *
 * Next 16 renamed `middleware` to `proxy`; the export is `proxy` and the
 * runtime is Node (not configurable), which suits us because the signature
 * check uses node:crypto.
 */
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifyCookieValue } from "./lib/auth";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  // The login page and its action must stay reachable.
  if (pathname === "/admin/login" || pathname === "/api/admin/login") return NextResponse.next();

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (verifyCookieValue(cookie, new Date())) return NextResponse.next();

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
