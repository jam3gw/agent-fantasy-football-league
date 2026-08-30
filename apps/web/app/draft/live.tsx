"use client";
/**
 * The live half of the draft room: polls `/api/draft/state` every 3 seconds
 * with SWR (SPEC §10.2) and refreshes the server-rendered board whenever a new
 * pick lands. Deliberately tiny — everything else on `/draft` is a server
 * component. SWR pauses the poll while the tab is hidden and revalidates on
 * focus, which the old hand-rolled interval never did.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Badge, Card, Empty } from "../../components/ui";

interface RecentPick {
  pickNo: number;
  round: number;
  teamName: string | null;
  playerName: string;
  position: string | null;
  nflTeam: string | null;
  madeBy: "agent" | "autopick";
}

interface DraftState {
  now: string;
  status: "not_started" | "running" | "paused" | "complete";
  currentPick: number | null;
  round: number | null;
  slotInRound: number | null;
  picksMade: number;
  totalPicks: number;
  secondsRemaining: number | null;
  onTheClock: { teamId: number; slug: string; name: string | null; model: string | null } | null;
  recentPicks: RecentPick[];
}

const POLL_MS = 3_000;

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function secondsLeft(deadline: number | null): number | null {
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

async function fetchDraftState(url: string): Promise<DraftState> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`draft state ${res.status}`);
  return (await res.json()) as DraftState;
}

export default function DraftLive() {
  const router = useRouter();
  const [left, setLeft] = useState<number | null>(null);
  /** Deadline on the local clock, so a skewed browser clock cannot break it. */
  const deadline = useRef<number | null>(null);
  const picksSeen = useRef<number | null>(null);

  const { data: state, error } = useSWR("/api/draft/state", fetchDraftState, {
    refreshInterval: POLL_MS,
    revalidateOnFocus: true,
    dedupingInterval: 1_000,
    onSuccess: (data) => {
      deadline.current = data.secondsRemaining === null ? null : Date.now() + data.secondsRemaining * 1000;
      setLeft(secondsLeft(deadline.current));
      // A new pick means the board below is stale: re-render it on the server.
      if (picksSeen.current !== null && data.picksMade !== picksSeen.current) router.refresh();
      picksSeen.current = data.picksMade;
    },
  });
  const offline = Boolean(error);

  useEffect(() => {
    const ticker = setInterval(() => setLeft(secondsLeft(deadline.current)), 1_000);
    return () => clearInterval(ticker);
  }, []);

  if (!state) {
    return (
      <Card title="On the clock">
        <Empty>{offline ? "Draft state unavailable — retrying." : "Connecting to the draft…"}</Empty>
      </Card>
    );
  }

  return (
    <Card
      title="On the clock"
      action={
        offline ? (
          <Badge tone="danger">reconnecting</Badge>
        ) : (
          <span className="text-xs text-muted">updates every 3s</span>
        )
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xl font-semibold">
            {state.onTheClock ? (state.onTheClock.name ?? state.onTheClock.slug) : "—"}
          </p>
          <p className="text-sm text-muted">
            {state.onTheClock?.model ? `${state.onTheClock.model} · ` : ""}
            {state.round !== null ? `round ${state.round}` : ""}
            {state.currentPick !== null ? `, pick ${state.currentPick} of ${state.totalPicks}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums">{left === null ? "—" : mmss(left)}</p>
          <p className="text-xs text-muted">
            {state.status === "paused" ? "paused" : left === 0 ? "auto-pick imminent" : "on the clock"}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Latest picks</h3>
        {state.recentPicks.length === 0 ? (
          <Empty>No picks yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {state.recentPicks.slice(0, 8).map((p) => (
              <li key={p.pickNo} className="flex flex-wrap items-baseline gap-2">
                <span className="w-10 shrink-0 text-xs text-muted tabular-nums">#{p.pickNo}</span>
                <span className="font-medium">{p.playerName}</span>
                <span className="text-xs text-muted">
                  {[p.position, p.nflTeam].filter(Boolean).join(" · ")}
                </span>
                <span className="text-muted">to {p.teamName ?? "—"}</span>
                {p.madeBy === "autopick" ? <Badge tone="warn">autopick</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
