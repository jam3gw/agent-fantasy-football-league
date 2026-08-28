import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, COOKIE_OPTIONS, issueCookieValue, passwordMatches } from "../../../../lib/auth";

/**
 * Commissioner login (SPEC §12.2). The password is compared in constant time
 * against COMMISSIONER_PASSWORD and is never logged, echoed, or stored.
 *
 * `proxy.ts` lets this route through unauthenticated; it is the only /api/admin
 * route that anonymous requests may reach.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const password = form.get("password");
  const next = safeNext(typeof form.get("next") === "string" ? String(form.get("next")) : undefined);

  const okPassword = typeof password === "string" && password.length > 0 && passwordMatches(password);
  if (!okPassword) {
    // 303 so the browser follows with GET. No password material in the URL.
    return NextResponse.redirect(
      new URL(`/admin/login?error=1&next=${encodeURIComponent(next)}`, request.url),
      { status: 303 },
    );
  }

  const response = NextResponse.redirect(new URL(next, request.url), { status: 303 });
  response.cookies.set(COOKIE_NAME, issueCookieValue(new Date()), COOKIE_OPTIONS);
  return response;
}

/** Same-site paths only — an open redirect here would be a real hole. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/admin";
  return next;
}
