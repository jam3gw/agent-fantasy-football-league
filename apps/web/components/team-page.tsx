"use client";

/**
 * The three interactive pieces of a team page, each a thin shell around
 * content the server has already rendered: the agent's notes that open and
 * close, the Activity tabs, and a move's summary clamped to a few lines.
 * Everything inside them arrives as children, so the markdown, the links and
 * the session rows stay server-rendered.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * The scratchpad card. Collapsed to a few hundred pixels with a fade, because
 * an agent's notes run long and the moves below them are worth reaching;
 * "Read the full notes" opens it. The version history sits under the card and
 * shows on request.
 */
export function NotesCard({
  children,
  versions,
  versionCount,
  collapsible,
}: {
  children: ReactNode;
  versions: ReactNode;
  versionCount: number;
  collapsible: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const collapsed = collapsible && !open;
  const notesId = useId();
  const versionsId = useId();
  const card = useRef<HTMLDivElement>(null);
  // Collapsing a long note pulls the page up from under a reader who had
  // scrolled into it; bring the card's top back into view so the button they
  // pressed is where they left it.
  const toggle = () => {
    setOpen((o) => !o);
    if (open) {
      requestAnimationFrame(() => {
        const top = card.current?.getBoundingClientRect().top ?? 0;
        if (top < 0) card.current?.scrollIntoView({ block: "start" });
      });
    }
  };
  return (
    <div>
      <div ref={card} className="relative scroll-mt-6 rounded-xl border border-border bg-surface">
        <div
          id={notesId}
          className={`overflow-hidden px-[22px] pt-5 text-[14px] leading-[1.7] transition-[max-height] duration-300 ${
            collapsed ? "max-h-[300px]" : "max-h-none"
          }`}
        >
          {children}
        </div>
        {collapsed ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 rounded-b-xl bg-[linear-gradient(to_bottom,rgba(255,253,249,0),#fffdf9_70%)]"
          />
        ) : null}
        <div className="relative flex flex-wrap items-center justify-between gap-3 px-[22px] pb-3.5 pt-3.5">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={notesId}
              onClick={toggle}
              className="rounded-md border border-border-strong bg-transparent px-4 py-1.5 text-[13px] font-medium text-foreground transition-colors duration-300 hover:border-accent hover:bg-accent-soft hover:text-accent"
            >
              {collapsed ? "Read the full notes" : "Collapse notes"}
            </button>
          ) : (
            <span />
          )}
          {versionCount > 0 ? (
            <button
              type="button"
              aria-expanded={showVersions}
              aria-controls={versionsId}
              onClick={() => setShowVersions((v) => !v)}
              className="group inline-flex items-center gap-1.5 text-[13px] font-medium text-accent transition-colors hover:text-accent-hover"
            >
              {showVersions ? "Hide the versions" : `See all ${versionCount} version${versionCount === 1 ? "" : "s"}`}
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform duration-300 ${showVersions ? "rotate-90" : "group-hover:translate-x-[3px]"}`}
              >
                <path d="M2 8h11M9 4l4 4-4 4" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
      <div id={versionsId} hidden={!showVersions} className="mt-3">
        {versions}
      </div>
    </div>
  );
}

export interface ActivityTab {
  key: string;
  label: string;
  count: number;
  intro: string;
  panel: ReactNode;
}

/** The segmented control over moves, sessions and check-ins, and the panel it picks. */
export function ActivityTabs({ tabs }: { tabs: ActivityTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  const baseId = useId();
  const list = useRef<HTMLDivElement>(null);
  if (!current) return null;
  // Left and right move between tabs and focus the one picked, as the ARIA
  // tabs pattern asks; Home and End jump to the ends.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === current.key);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActive(tabs[next].key);
    list.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-[-0.02em]">Activity</h2>
        <div
          ref={list}
          role="tablist"
          aria-label="Activity"
          onKeyDown={onKeyDown}
          className="flex gap-1 rounded-full border border-[rgba(42,40,35,0.14)] bg-surface p-[3px]"
        >
          {tabs.map((t) => {
            const on = t.key === current.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.key}`}
                aria-selected={on}
                aria-controls={`${baseId}-panel-${t.key}`}
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(t.key)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors duration-300 ${
                  on ? "bg-foreground text-background" : "bg-transparent text-muted hover:text-accent"
                }`}
              >
                {t.label}
                <span className="text-[11px] font-medium tabular-nums opacity-60">{t.count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-[13px] text-muted">{current.intro}</p>
      {/* Every panel stays in the document so each tab's aria-controls
          resolves; only the picked one is shown. */}
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`${baseId}-panel-${t.key}`}
          aria-labelledby={`${baseId}-tab-${t.key}`}
          hidden={t.key !== current.key}
          className="mt-3.5"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}

/**
 * A move's summary held to a few lines with a "More" under it when there is
 * more to read. `long` is the server's call from the text's length, so the
 * button never appears on a one-liner.
 */
export function Clamp({ long, children }: { long: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <div id={id} className={long && !open ? "line-clamp-3" : undefined}>
        {children}
      </div>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="mt-1 border-0 bg-transparent p-0 text-[12px] font-semibold text-accent"
        >
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}
