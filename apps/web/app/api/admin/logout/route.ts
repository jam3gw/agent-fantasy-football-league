import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, COOKIE_OPTIONS } from "../../../../lib/auth";

/** Clear the commissioner cookie and go back to the public site. */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.cookies.set(COOKIE_NAME, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
