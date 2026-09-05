"use client";
/**
 * The step rail beside the transcript: one row per step, the row for whatever
 * is on screen highlighted, and a control that opens or closes every step at
 * once.
 *
 * It is a scrollspy over one scrolling transcript rather than a two-pane
 * selector. The steps are short and the reader is following an argument, so
 * the rail's job is to say where you are in it and let you jump — not to hide
 * five of the six steps behind a click.
 *
 * This is the only client component the page adds. The steps themselves stay
 * server-rendered, which is also why open/close is done by setting `open` on
 * the `<details>` elements directly: React never owns that state, so a reader
 * who has opened a step keeps it open when the live poll re-renders around it.
 */
import { useEffect, useState } from "react";
import { EVENTS } from "@/lib/analytics";
import { trackEvent } from "@/lib/track";

export interface RailStep {
  n: number;
  anchor: string;
  title: string;
  tools: string | null;
  decision: boolean;
}

/** Matches the sticky masthead plus the step card's own scroll margin. */
const SPY_MARGIN = "-140px 0px -55% 0px";

export function SessionRail({ steps, note }: { steps: RailStep[]; note?: string }) {
  const [active, setActive] = useState(steps[0]?.n ?? 0);
  const [allOpen, setAllOpen] = useState(false);

  useEffect(() => {
    // A step whose card is not mounted yet (the live view grows one step at a
    // time) is simply not observed; the effect re-runs as the list changes.
    const cards = steps
      .map((s) => document.getElementById(s.anchor))
      .filter((el): el is HTMLElement => el !== null);
    if (cards.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number(entry.target.id.replace("step-", ""));
          if (Number.isInteger(n)) setActive(n);
        }
      },
      { rootMargin: SPY_MARGIN, threshold: 0 },
    );
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [steps]);

  const toggleAll = () => {
    const next = !allOpen;
    document.querySelectorAll<HTMLDetailsElement>("[data-step-card]").forEach((card) => {
      card.open = next;
    });
    setAllOpen(next);
    trackEvent(EVENTS.toggleSteps, { open: next, steps: steps.length });
  };

  return (
    <nav aria-label="Session steps" className="flex flex-col gap-0.5 lg:sticky lg:top-24">
      <div className="flex items-baseline justify-between gap-2 px-2.5 pb-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-faint">Steps</span>
        <button
          type="button"
          onClick={toggleAll}
          className="text-[12px] text-accent transition-colors hover:text-accent-hover"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {steps.map((step) => {
        const on = step.n === active;
        return (
          <a
            key={step.n}
            href={`#${step.anchor}`}
            aria-current={on ? "true" : undefined}
            className={`block rounded-r-md border-l-2 px-3 py-2 transition-colors ${
              on ? "border-accent bg-accent-soft" : "border-transparent hover:bg-background-alt"
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] tabular-nums text-faint">{step.n}</span>
              <span
                className={`text-[13px] leading-[1.4] ${on ? "font-semibold" : ""} ${
                  step.decision ? "text-accent" : "text-foreground"
                }`}
              >
                {step.title}
              </span>
            </div>
            {step.tools ? (
              <div className="ml-[19px] truncate font-mono text-[11px] leading-[1.4] text-faint">{step.tools}</div>
            ) : null}
          </a>
        );
      })}

      {note ? (
        <p className="mt-3 border-t border-border px-3 pt-2.5 text-[11px] leading-[1.6] text-faint">{note}</p>
      ) : null}
    </nav>
  );
}
