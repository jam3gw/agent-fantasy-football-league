"use client";
/**
 * The live half of the session transcript (SPEC §12.1): while a session is
 * queued or running this view polls `/api/public/sessions/[id]/live` with SWR,
 * accumulates transcript events as the runner writes them, and shows the
 * in-flight partial output — what the agent is thinking while it thinks it.
 *
 * Rendering is shared with the static page via `components/session-view`, so a
 * step looks exactly like the same step after the session ends: the reader
 * watches the transcript being built, rather than watching a different page
 * that is replaced by the real one when the session finishes. When the session
 * reaches a terminal status the poll stops and the accumulated transcript
 * stands as the complete record.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveWatched } from "@/lib/useLiveWatched";
import useSWR from "swr";
import { LiveDot } from "@/components/broadcast";
import { SessionFacts, SessionHeader, SessionTranscript } from "@/components/session-view";
import { Empty, money } from "@/components/ui";
import type { SessionSummaryData, SessionTeamData, TranscriptEvent } from "@/components/transcript";
import { compactTokens, formatSeconds, groupSteps, toDate } from "@/lib/sessionTranscript";

interface LiveResponse {
  session: SessionSummaryData;
  team: SessionTeamData | null;
  events: TranscriptEvent[];
  hasMore: boolean;
  stream: { stepNo: number; reasoning: string; text: string; updatedAt: string } | null;
}

const POLL_MS = 2_500;

const ACTIVE_STATUSES = new Set(["queued", "running"]);

/**
 * The elapsed clock. The poll is every 2.5 seconds but a stopped timer reads
 * as a stalled session, so the seconds are counted locally from the session's
 * own start time and corrected by every poll that carries a new one.
 */
function useElapsed(startedAt: string | Date | null, active: boolean): string | null {
  const startMs = toDate(startedAt)?.getTime() ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || startMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, startMs]);

  if (startMs === null) return null;
  return formatSeconds(Math.max(0, Math.round((now - startMs) / 1000)));
}

/**
 * The in-flight step: the partial reasoning and text the runner stages while
 * `streamText` streams, under a pulsing dot and the counters that are moving.
 * This is the whole point of the live view — an agent thinking in public — so
 * it sits above the steps it is about to become.
 */
function ThinkingCard({
  stream,
  elapsed,
  costUsd,
  tokens,
}: {
  stream: NonNullable<LiveResponse["stream"]>;
  elapsed: string | null;
  costUsd: number;
  tokens: number;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-accent/50 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <LiveDot />
        <span className="text-[14px] font-semibold text-accent">Thinking</span>
        {elapsed ? <span className="text-[13px] tabular-nums text-muted">{elapsed}</span> : null}
        <span className="ml-auto text-[12px] tabular-nums text-muted">
          {money(costUsd)} · {compactTokens(tokens)} tokens
        </span>
      </div>
      {stream.reasoning !== "" ? (
        <p className="mt-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-[1.7] text-muted">
          {stream.reasoning}
        </p>
      ) : null}
      {stream.text !== "" ? (
        <p className="mt-3 whitespace-pre-wrap text-[14px] leading-[1.7] text-foreground">{stream.text}</p>
      ) : null}
    </section>
  );
}

/** Queued, or running before the first token: say which, and keep the shape. */
function WaitingCard({ status }: { status: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <LiveDot />
        <span className="text-[14px] font-medium text-muted">
          {status === "queued"
            ? "Queued — waiting for a slot. The transcript starts the moment it gets one."
            : "Connecting to the live transcript…"}
        </span>
      </div>
    </section>
  );
}

export default function LiveSession({
  sessionId,
  initialSession,
  initialTeam,
}: {
  sessionId: number;
  initialSession: SessionSummaryData;
  initialTeam: SessionTeamData | null;
}) {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [summary, setSummary] = useState<SessionSummaryData>(initialSession);
  const [team, setTeam] = useState<SessionTeamData | null>(initialTeam);
  const [stream, setStream] = useState<LiveResponse["stream"]>(null);
  // The poll cursor: the highest seq already accumulated. A ref, not state —
  // the SWR key must stay stable so it keeps one cache entry per session.
  const after = useRef(-1);

  const active = ACTIVE_STATUSES.has(summary.status);
  const elapsed = useElapsed(summary.startedAt, active);
  useLiveWatched("session", summary.status === "running");

  const fetchLive = useCallback(async (): Promise<LiveResponse> => {
    const res = await fetch(`/api/public/sessions/${sessionId}/live?after=${after.current}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`live session ${res.status}`);
    return (await res.json()) as LiveResponse;
  }, [sessionId]);

  const { error, mutate } = useSWR(`session-live-${sessionId}`, fetchLive, {
    refreshInterval: active ? POLL_MS : 0,
    revalidateOnFocus: active,
    dedupingInterval: 500,
    onSuccess: (data) => {
      setSummary(data.session);
      if (data.team) setTeam(data.team);
      // An assistant event supersedes the staged partial of its own step even
      // when the runner has not deleted the row yet (the response can catch
      // the moment between the event insert and the delete) — showing both
      // would render the same step twice. A partial from a LATER step than
      // every assistant event in the batch is genuinely new thinking and
      // stays. Events without step_no (recorded before it existed) suppress
      // conservatively.
      const supersedes =
        data.stream !== null &&
        data.events.some((e) => {
          if (e.type !== "assistant") return false;
          const step = e.content.step_no;
          return typeof step !== "number" || step >= data.stream!.stepNo;
        });
      setStream(supersedes ? null : data.stream);
      if (data.events.length > 0) {
        after.current = data.events[data.events.length - 1]!.seq;
        setEvents((prev) => {
          const known = new Set(prev.map((e) => e.seq));
          const fresh = data.events.filter((e) => !known.has(e.seq));
          return fresh.length === 0 ? prev : [...prev, ...fresh];
        });
      }
      // A burst bigger than one page: catch up immediately instead of waiting
      // out the poll interval.
      if (data.hasMore) void mutate();
    },
  });

  const thinking =
    active && stream !== null && (stream.reasoning !== "" || stream.text !== "") ? (
      <ThinkingCard
        stream={stream}
        elapsed={elapsed}
        costUsd={summary.costUsd}
        tokens={summary.inputTokens + summary.outputTokens}
      />
    ) : active ? (
      <WaitingCard status={summary.status} />
    ) : null;

  return (
    <div className="flex flex-col gap-5">
      <SessionHeader
        session={summary}
        team={team}
        action={
          active ? (
            error ? (
              <span className="rounded-md border border-danger/40 px-2.5 py-1 text-[12px] font-medium text-danger">
                reconnecting
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">
                <LiveDot />
                live — updates every {Math.round(POLL_MS / 1000)}s
              </span>
            )
          ) : (
            <span className="text-[12px] text-muted">session finished</span>
          )
        }
      />
      <SessionFacts
        session={summary}
        steps={groupSteps(events).length}
        elapsedLabel={active ? elapsed : null}
      />

      {events.length === 0 && thinking === null ? (
        <Empty>No transcript events were recorded for this session.</Empty>
      ) : (
        <SessionTranscript events={events} session={summary} team={team} live={thinking} />
      )}
    </div>
  );
}
