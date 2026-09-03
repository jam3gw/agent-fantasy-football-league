"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * Filter state that lives in the URL, so a filtered view is a link.
 *
 * The page stays a prerendered server component: nothing here reads
 * `searchParams` on the server, which would make the route dynamic and drop
 * its §12.1 cache. The URL is read in the browser after mount (so the
 * prerendered HTML is the unfiltered list and no Suspense bailout is needed),
 * and writes go through `history.replaceState`, which the App Router keeps
 * in sync without a navigation or a fetch. Back and forward re-read it.
 */
export function useUrlState(): {
  get: (key: string) => string;
  set: (patch: Record<string, string | undefined>) => void;
} {
  const [params, setParams] = useState<URLSearchParams>(() => new URLSearchParams());

  useEffect(() => {
    const read = () => setParams(new URLSearchParams(window.location.search));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const get = useCallback((key: string) => params.get(key) ?? "", [params]);
  const set = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (!value || value === "all") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
      setParams(next);
    },
    [],
  );
  return { get, set };
}

export const selectClass =
  "rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-foreground";

export function FilterSelect({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The "all" option's text; omit for a sort select that has no "all". */
  allLabel?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {allLabel ? <option value="all">{allLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}

/** The bar the selects sit in, with the count line on the right. */
export function FilterBar({ children, count }: { children: ReactNode; count?: string }) {
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
      {children}
      {count ? <span className="text-[12px] text-faint">{count}</span> : null}
    </div>
  );
}

export function ShowMore({ more, onClick, noun }: { more: number; onClick: () => void; noun: string }) {
  if (more <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-accent hover:border-accent"
    >
      Show more ({more} more {noun})
    </button>
  );
}
