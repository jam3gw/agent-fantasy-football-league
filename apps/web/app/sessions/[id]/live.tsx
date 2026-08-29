"use client";
/**
 * The live half of the session transcript (SPEC §12.1): while a session is
 * queued or running this view polls `/api/public/sessions/[id]/live` with SWR,
 * accumulates transcript events as the runner writes them, and shows the
 * in-flight partial output — what the agent is thinking while it thinks it.
 *
 * Rendering is shared with the static page via `components/transcript`, so a
 * live event looks exactly like the same event after the session ends. When
 * the session reaches a terminal status the poll stops and the accumulated
 * transcript stands as the complete record.
 */
import { useCallback, useRef, useState } from "react";
import useSWR from "swr";
import { Badge, Card, Empty } from "@/components/ui";
import {
  Json,
  SessionSummaryCard,
  TranscriptEventItem,
  type SessionSummaryData,
  type SessionTeamData,
  type TranscriptEvent,
} from "@/components/transcript";

interface LiveResponse {
  session: SessionSummaryData;
  team: SessionTeamData | null;
  events: TranscriptEvent[];
  hasMore: boolean;
  stream: { stepNo: number; reasoning: string; text: string; updatedAt: string } | null;
}

const POLL_MS = 2_500;

const ACTIVE_STATUSES = new Set(["queued", "running"]);

function ThinkingStream({ stream }: { stream: NonNullable<LiveResponse["stream"]> }) {
  if (stream.reasoning === "" && stream.text === "") return null;
  return (
    <li className="rounded border border-accent/40 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone="accent">thinking</Badge>
        <span className="text-xs text-muted">
          streaming live
          <span className="ml-1 inline-block animate-pulse">●</span>
        </span>
      </div>
      {stream.reasoning !== "" ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm italic leading-relaxed text-muted">
          {stream.reasoning}
        </p>
      ) : null}
      {stream.text !== "" ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{stream.text}</p>
      ) : null}
    </li>
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
      // A batch that carries an assistant event supersedes the staged partial
      // even when the runner has not deleted the row yet (the response can
      // catch the moment between the event insert and the delete) — showing
      // both would render the same step twice.
      const supersedes = data.events.some((e) => e.type === "assistant");
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

  const errors = events.filter((e) => e.type === "error");

  return (
    <div className="space-y-6">
      <SessionSummaryCard
        session={summary}
        team={team}
        action={
          active ? (
            error ? (
              <Badge tone="danger">reconnecting</Badge>
            ) : (
              <span className="text-xs text-muted">
                live — updates every {Math.round(POLL_MS / 1000)}s
                <span className="ml-1 inline-block animate-pulse text-accent">●</span>
              </span>
            )
          ) : (
            <span className="text-xs text-muted">session finished</span>
          )
        }
      />

      {errors.length > 0 ? (
        <Card title={`Errors (${errors.length})`}>
          {errors.map((e) => (
            <Json key={e.seq} value={e.content} />
          ))}
        </Card>
      ) : null}

      <Card title={`Transcript (${events.length} events${active ? ", live" : ""})`}>
        {events.length === 0 && stream === null ? (
          <Empty>
            {summary.status === "queued"
              ? "Session is queued — waiting for a slot. The transcript starts here the moment it does."
              : active
                ? "Connecting to the live transcript…"
                : "No transcript events were recorded for this session."}
          </Empty>
        ) : (
          <ol className="space-y-4">
            {events.map((event) => (
              <TranscriptEventItem key={event.seq} event={event} />
            ))}
            {active && stream !== null ? <ThinkingStream stream={stream} /> : null}
          </ol>
        )}
      </Card>

      <p className="text-xs text-muted">
        Every session is public: the same prompt, the same tools, and the same information go to all twelve models.
      </p>
    </div>
  );
}
