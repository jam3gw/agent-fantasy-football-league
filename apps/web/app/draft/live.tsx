"use client";
/**
 * The live half of the draft room: polls `/api/draft/state` every 3 seconds
 * (SPEC §10.2) and refreshes the server-rendered board whenever a new pick
 * lands. Deliberately tiny — everything else on `/draft` is a server component.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

interface Snapshot {
  data: DraftState;
  /** Local-clock deadline, so a skewed browser clock cannot break the count. */
  deadlineLocal: number | null;
}

const POLL_MS = 3_000;

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function DraftLive() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [, retick] = useState(0);
  const picksSeen = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/draft/state", { cache: "no-store" });
        if (!res.ok) throw new Error(`draft state ${res.status}`);
        const data = (await res.json()) as DraftState;
        if (cancelled) return;
        setSnapshot({
          data,
          deadlineLocal: data.secondsRemaining === null ? null : Date.now() + data.secondsRemaining * 1000,
        });
        setOffline(false);
        // A new pick means the board below is stale: re-render it on the server.
        if (picksSeen.current !== null && data.picksMade !== picksSeen.current) router.refresh();
        picksSeen.current = data.picksMade;
      } catch {
        if (!cancelled) setOffline(true);
      }
    }

    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const seconds = setInterval(() => retick((n) => n + 1), 1_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(seconds);
    };
  }, [router]);

  if (!snapshot) {
    return (
      <Card title="On the clock">
        <Empty>{offline ? "Draft state unavailable — retrying." : "Connecting to the draft…"}</Empty>
      </Card>
    );
  }

  const { data, deadlineLocal } = snapshot;
  const left = deadlineLocal === null ? null : Math.max(0, Math.ceil((deadlineLocal - Date.now()) / 1000));

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
            {data.onTheClock ? (data.onTheClock.name ?? data.onTheClock.slug) : "—"}
          </p>
          <p className="text-sm text-muted">
            {data.onTheClock?.model ? `${data.onTheClock.model} · ` : ""}
            {data.round !== null ? `round ${data.round}` : ""}
            {data.currentPick !== null ? `, pick ${data.currentPick} of ${data.totalPicks}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums">{left === null ? "—" : mmss(left)}</p>
          <p className="text-xs text-muted">
            {data.status === "paused" ? "paused" : left === 0 ? "auto-pick imminent" : "on the clock"}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Latest picks</h3>
        {data.recentPicks.length === 0 ? (
          <Empty>No picks yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.recentPicks.slice(0, 8).map((p) => (
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
