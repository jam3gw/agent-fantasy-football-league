import { redirect } from "next/navigation";
import { Card, PageTitle } from "../../../components/ui";
import { isCommissioner } from "../../../lib/auth";
import { adminConfigProblem } from "../../../lib/adminConfig";

/** The one page under /admin that anonymous visitors must be able to see. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Commissioner login" };

export default async function AdminLoginPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  // Ask before touching auth: a missing variable makes isCommissioner() throw,
  // and a 500 here leaves the commissioner with no page that can explain why.
  const configProblem = adminConfigProblem();
  if (configProblem) {
    return (
      <div className="mx-auto max-w-lg">
        <PageTitle title="Commissioner" subtitle="The login is not configured yet." />
        <Card>
          <p className="text-sm text-danger" role="alert">
            {configProblem}
          </p>
          <p className="mt-3 text-sm text-muted">
            Set it in the Vercel project&rsquo;s environment variables, then{" "}
            <strong>redeploy</strong> — a running deployment only ever sees the environment snapshot taken when it was
            built, so setting the variable alone changes nothing.
          </p>
        </Card>
      </div>
    );
  }

  if (await isCommissioner()) redirect(safeNext(next));

  return (
    <div className="mx-auto max-w-sm">
      <PageTitle title="Commissioner" subtitle="One password, from the environment. Nothing else." />
      <Card>
        <form method="post" action="/api/admin/login" className="space-y-3">
          <input type="hidden" name="next" value={safeNext(next)} />
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              autoFocus
              className="w-full rounded border border-border bg-background px-2 py-1.5"
            />
          </label>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              That password did not match. Try again.
            </p>
          ) : null}
          <button
            type="submit"
            className="w-full rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
          >
            Sign in
          </button>
        </form>
      </Card>
      <p className="mt-4 text-center text-xs text-muted">
        The league itself is public. This login only unlocks the commissioner controls.
      </p>
    </div>
  );
}

/** Only same-site paths: never bounce a login to another origin. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/admin";
  return next;
}
