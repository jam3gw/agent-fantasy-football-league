/**
 * The session page's shell: the header, the six facts a reader asked for, the
 * outcome banner, the rail and the steps.
 *
 * The static page and the live view differ in exactly one way — whether a
 * session is still running — so both render this and hand it the events they
 * have. Everything is presentation over serialisable props (the rail is the
 * one client island), which is what keeps a step identical on both sides.
 */
import Link from "next/link";
import { formatEt } from "@league/shared";
import { OutcomeBanner, Fact, StepCard } from "@/components/session-steps";
import { SessionRail, type RailStep } from "@/components/session-rail";
import type { SessionSummaryData, SessionTeamData, TranscriptEvent } from "@/components/transcript";
import { money } from "@/components/ui";
import {
  compactTokens,
  formatDuration,
  groupSteps,
  isDecisionStep,
  outcomeOf,
  playerIndex,
  stepAnchor,
  stepTitle,
  stepToolLabel,
} from "@/lib/sessionTranscript";

/** What each session kind is, in a reader's words rather than the enum's. */
const KIND_LABEL: Record<string, string> = {
  onboarding: "Onboarding",
  draft_pick: "Draft pick",
  weekly_review: "Weekly review",
  post_waivers: "Post-waivers check",
  trade_window: "Trade window",
  trade_response: "Trade response",
  trade_vote: "Trade vote",
  lineup_check: "Lineup check",
  injury_response: "Injury response",
  board_reply: "Board reply",
  self_check_in: "Self check-in",
  manual: "Manual run",
  smoke: "Smoke test",
  reporter_draft_grades: "Draft grades",
  reporter_recap: "Weekly recap",
  reporter_preview: "Week preview",
  reporter_trade_note: "Trade note",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ");
}

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-accent",
  running: "text-accent",
  queued: "text-muted",
  failed: "text-danger",
  timed_out: "text-danger",
  skipped: "text-muted",
};

export function SessionHeader({
  session,
  team,
  action,
}: {
  session: SessionSummaryData;
  team: SessionTeamData | null;
  action?: React.ReactNode;
}) {
  const started = session.startedAt ? new Date(session.startedAt) : null;
  const teamName = team?.name ?? team?.slug ?? null;

  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          {team ? (
            <>
              <Link href={`/teams/${team.slug}`} className="hover:text-accent">
                {teamName}
              </Link>
              <span aria-hidden="true">/</span>
            </>
          ) : null}
          <span className="tabular-nums">Session {session.id}</span>
        </div>
        <h1 className="mt-1.5 text-[26px] font-bold leading-[1.2] tracking-[-0.03em]">
          {kindLabel(session.kind)}
          {teamName ? <span className="text-muted"> — {teamName}</span> : null}
        </h1>
        <p className="mt-1.5 text-[14px] text-muted">
          {started ? formatEt(started) : "not started"} · {team?.modelLabel ?? session.modelId} · triggered by{" "}
          {session.trigger}
        </p>
      </div>
      {action}
    </div>
  );
}

/**
 * The six facts the header leads with. Tokens are compact with the exact
 * count in the title, because the number a reader wants at a glance is the
 * order of magnitude and the number they occasionally want is exact.
 */
export function SessionFacts({
  session,
  steps,
  elapsedLabel,
}: {
  session: SessionSummaryData;
  steps: number;
  elapsedLabel?: string | null;
}) {
  const total = session.inputTokens + session.outputTokens;
  const duration = elapsedLabel ?? formatDuration(session.startedAt, session.endedAt) ?? "—";

  return (
    <dl className="grid grid-cols-2 gap-x-7 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
      <Fact
        label="Status"
        value={<span className={STATUS_TONE[session.status] ?? ""}>{session.status.replace("_", " ")}</span>}
        sub={session.endedBy ? `ended by the ${session.endedBy.replace(/_/g, " ")}` : undefined}
      />
      <Fact label="Duration" value={duration} />
      <Fact label="Cost" value={money(session.costUsd)} />
      <Fact label="Steps" value={steps} />
      <Fact
        label="Tool calls"
        value={session.toolCalls}
        sub={session.invalidToolCalls > 0 ? `${session.invalidToolCalls} invalid` : "0 invalid"}
      />
      <Fact
        label="Tokens"
        value={<span title={`${total.toLocaleString()} in + out`}>{compactTokens(total)}</span>}
        sub={
          session.reasoningTokens > 0 ? `${compactTokens(session.reasoningTokens)} reasoning` : undefined
        }
      />
    </dl>
  );
}

/**
 * The transcript proper: the rail on the left, the steps on the right.
 *
 * The decision step opens by default. It is the one step a reader almost
 * always wants open, and leaving every step shut means the page's first
 * impression is a stack of closed boxes.
 */
export function SessionTranscript({
  events,
  session,
  team,
  live,
}: {
  events: TranscriptEvent[];
  session: SessionSummaryData;
  team: SessionTeamData | null;
  /** Rendered above the steps while the session is still running. */
  live?: React.ReactNode;
}) {
  const steps = groupSteps(events);
  const players = playerIndex(events);
  const outcome = outcomeOf(steps);

  const rail: RailStep[] = steps.map((step) => ({
    n: step.n,
    anchor: stepAnchor(step),
    title: stepTitle(step),
    tools: stepToolLabel(step),
    decision: isDecisionStep(step),
  }));

  return (
    <>
      <OutcomeBanner outcome={outcome} players={players} status={session.status} teamSlug={team?.slug ?? null} />

      <div className="grid items-start gap-8 lg:grid-cols-[228px_minmax(0,1fr)]">
        <div className="hidden lg:block">
          <SessionRail
            steps={rail}
            note={
              session.endedBy
                ? `Ended by the ${session.endedBy.replace(/_/g, " ")}. Cost accrues per step, shown inline.`
                : "Cost accrues per step, shown inline."
            }
          />
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          {live}
          {steps.map((step) => (
            <StepCard
              key={step.seq}
              step={step}
              players={players}
              defaultOpen={outcome.anchorStep === step.n}
            />
          ))}
          {session.error ? (
            <p className="rounded-xl border border-danger/40 px-4 py-3 text-[14px] text-danger">
              This session ended with an error: {session.error}
            </p>
          ) : null}
          <p className="mt-1 text-[12px] leading-[1.6] text-faint">
            Every session is public: the same prompt, the same tools, and the same information go to all twelve
            models.
          </p>
        </div>
      </div>
    </>
  );
}
