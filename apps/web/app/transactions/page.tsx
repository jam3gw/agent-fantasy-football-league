/**
 * `/transactions` — every transaction, filterable by team and type
 * (SPEC §12.1). Each payload is rendered for its type rather than dumped as
 * raw JSON; commissioner actions appear here too (§12.2).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { and, arrayContains, desc, eq, inArray } from "drizzle-orm";
import { players, teams, transactions, type TransactionType } from "@league/engine";
import { db } from "../../lib/db";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel } from "../../components/ui";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

const LIMIT = 200;

const TYPES: readonly TransactionType[] = [
  "draft_pick",
  "add",
  "drop",
  "waiver_add",
  "trade",
  "ir_move",
  "lineup",
  "commissioner",
];

const TYPE_LABEL: Record<TransactionType, string> = {
  draft_pick: "Draft pick",
  add: "Free-agent add",
  drop: "Drop",
  waiver_add: "Waiver claim",
  trade: "Trade",
  ir_move: "IR move",
  lineup: "Lineup",
  commissioner: "Commissioner",
};

type Team = typeof teams.$inferSelect;
type Payload = Record<string, unknown>;

/* ---------------------------------------------------------------- helpers */

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function isRecord(v: unknown): v is Payload {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function when(at: Date): string {
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function whenIso(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : when(at);
}

/** Every player id a payload can mention, so names are fetched in one query. */
function playerIdsIn(payload: Payload): string[] {
  const ids: string[] = [];
  for (const key of ["playerId", "player_id", "dropPlayerId", "drop_player_id", "addPlayerId", "add_player_id"]) {
    const v = str(payload[key]);
    if (v) ids.push(v);
  }
  for (const key of ["givePlayerIds", "getPlayerIds", "playerIds"]) ids.push(...strList(payload[key]));
  const diff = payload.diff;
  if (isRecord(diff)) {
    for (const entry of Object.values(diff)) {
      if (!isRecord(entry)) continue;
      const from = str(entry.from);
      const to = str(entry.to);
      if (from) ids.push(from);
      if (to) ids.push(to);
    }
  }
  const slots = payload.slots;
  if (isRecord(slots)) {
    for (const v of Object.values(slots)) {
      const id = str(v);
      if (id) ids.push(id);
    }
  }
  return ids;
}

interface Ctx {
  nameOf: (playerId: string | null) => string;
  teamOf: (teamId: number) => Team | undefined;
}

function Player({ id, ctx }: { id: string | null; ctx: Ctx }) {
  if (!id) return null;
  return <span className="font-medium">{ctx.nameOf(id)}</span>;
}

/* -------------------------------------------------------- payload rendering */

function describe(type: TransactionType, payload: Payload, ctx: Ctx): ReactNode {
  switch (type) {
    case "draft_pick": {
      const round = num(payload.round);
      const pick = num(payload.pick_no);
      const auto = str(payload.made_by) === "autopick";
      const position = str(payload.position);
      const nflTeam = str(payload.nfl_team);
      const name = str(payload.name) ?? ctx.nameOf(str(payload.player_id));
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-muted">
              {round !== null ? `Round ${round}` : "Draft"}
              {pick !== null ? `, pick ${pick}` : ""}
            </span>
            <span className="font-medium">{name}</span>
            {position || nflTeam ? (
              <span className="text-xs text-muted">
                {[position, nflTeam].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            {auto ? <Badge tone="warn">autopick</Badge> : null}
          </div>
          {str(payload.reason) ? <p className="text-xs text-muted">{str(payload.reason)}</p> : null}
        </div>
      );
    }
    case "add": {
      const dropped = str(payload.dropPlayerId);
      return (
        <span>
          Added <Player id={str(payload.playerId)} ctx={ctx} />
          {dropped ? (
            <>
              {" "}
              · dropped <Player id={dropped} ctx={ctx} />
            </>
          ) : null}
        </span>
      );
    }
    case "waiver_add": {
      const dropped = str(payload.dropPlayerId);
      return (
        <span>
          Won waiver claim for <Player id={str(payload.playerId)} ctx={ctx} />
          {dropped ? (
            <>
              {" "}
              · dropped <Player id={dropped} ctx={ctx} />
            </>
          ) : null}
        </span>
      );
    }
    case "drop": {
      const clears = whenIso(str(payload.waiverUntil));
      const via = str(payload.via);
      return (
        <span>
          Dropped <Player id={str(payload.playerId)} ctx={ctx} />
          {clears ? <span className="text-muted"> · on waivers until {clears} ET</span> : null}
          {via ? <span className="text-xs text-muted"> ({via})</span> : null}
        </span>
      );
    }
    case "trade": {
      const proposer = num(payload.proposerTeamId);
      const counterparty = num(payload.counterpartyTeamId);
      const give = strList(payload.givePlayerIds).map((id) => ctx.nameOf(id));
      const get = strList(payload.getPlayerIds).map((id) => ctx.nameOf(id));
      const a = proposer !== null ? ctx.teamOf(proposer) : undefined;
      const b = counterparty !== null ? ctx.teamOf(counterparty) : undefined;
      const tradeId = num(payload.tradeId);
      return (
        <div className="space-y-1">
          <div className="text-sm">
            <span className="font-medium">{a?.name ?? "Team"}</span> sends {give.length ? give.join(", ") : "nothing"}
            {" → "}
            <span className="font-medium">{b?.name ?? "Team"}</span> sends {get.length ? get.join(", ") : "nothing"}
          </div>
          {tradeId !== null ? (
            <Link href="/trades" className="text-xs text-muted hover:text-accent">
              trade #{tradeId} on /trades
            </Link>
          ) : null}
        </div>
      );
    }
    case "lineup": {
      if (payload.carried_over === true) {
        const slots = isRecord(payload.slots) ? Object.keys(payload.slots).length : 0;
        return <span className="text-muted">Lineup carried over from the previous week ({slots} slots)</span>;
      }
      const diff = isRecord(payload.diff) ? payload.diff : {};
      const changes = Object.entries(diff).filter(([, v]) => isRecord(v));
      if (changes.length === 0) return <span className="text-muted">Lineup set (no changes)</span>;
      return (
        <ul className="space-y-0.5 text-sm">
          {changes.map(([slot, v]) => {
            const entry = isRecord(v) ? v : {};
            const from = str(entry.from);
            const to = str(entry.to);
            return (
              <li key={slot}>
                <span className="text-xs uppercase tracking-wide text-muted">{slot}</span>{" "}
                {from ? ctx.nameOf(from) : "empty"} → {to ? ctx.nameOf(to) : "empty"}
              </li>
            );
          })}
        </ul>
      );
    }
    case "ir_move": {
      const from = str(payload.fromSlot) ?? str(payload.from_slot);
      const to = str(payload.toSlot) ?? str(payload.to_slot);
      return (
        <span>
          <Player id={str(payload.playerId) ?? str(payload.player_id)} ctx={ctx} />
          {from || to ? (
            <span className="text-muted">
              {" "}
              {from ?? "roster"} → {to ?? "IR"}
            </span>
          ) : (
            <span className="text-muted"> moved to or from IR</span>
          )}
        </span>
      );
    }
    case "commissioner": {
      const action = str(payload.action) ?? "action";
      const rest = Object.entries(payload).filter(
        ([k, v]) => k !== "action" && k !== "at" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
      );
      return (
        <div className="space-y-1">
          <span className="font-medium">{action.replace(/_/g, " ")}</span>
          {rest.length > 0 ? (
            <p className="text-xs text-muted">{rest.map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</p>
          ) : null}
        </div>
      );
    }
  }
}

/* ------------------------------------------------------------------- page */

function FilterLinks({
  label,
  options,
  current,
  hrefFor,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  current: string | undefined;
  hrefFor: (value: string | undefined) => string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <Link
        href={hrefFor(undefined)}
        className={current === undefined ? "font-medium text-accent" : "text-muted hover:text-accent"}
      >
        all
      </Link>
      {options.map((o) => (
        <Link
          key={o.value}
          href={hrefFor(o.value)}
          className={current === o.value ? "font-medium text-accent" : "text-muted hover:text-accent"}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

async function TransactionsPageInner({
  searchParams,
}: {
  searchParams: Promise<{ team?: string | string[]; type?: string | string[] }>;
}) {
  const sp = await searchParams;
  const teamSlug = one(sp.team);
  const typeParam = one(sp.type);
  const type = TYPES.includes(typeParam as TransactionType) ? (typeParam as TransactionType) : undefined;

  const teamRows = await db().select().from(teams);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const team = teamSlug ? teamRows.find((t) => t.slug === teamSlug) : undefined;

  const rows = await db()
    .select()
    .from(transactions)
    .where(
      and(
        type ? eq(transactions.type, type) : undefined,
        team ? arrayContains(transactions.teamIds, [team.id]) : undefined,
      ),
    )
    .orderBy(desc(transactions.id))
    .limit(LIMIT);

  const ids = [...new Set(rows.flatMap((t) => playerIdsIn(t.payload)))];
  const playerRows = ids.length
    ? await db()
        .select({ playerId: players.playerId, fullName: players.fullName })
        .from(players)
        .where(inArray(players.playerId, ids))
    : [];
  const nameById = new Map(playerRows.map((p) => [p.playerId, p.fullName]));

  const ctx: Ctx = {
    nameOf: (playerId) => (playerId ? (nameById.get(playerId) ?? playerId) : "—"),
    teamOf: (teamId) => teamById.get(teamId),
  };

  const hrefWith = (next: { team?: string; type?: string }) => {
    const qs = new URLSearchParams();
    if (next.team) qs.set("team", next.team);
    if (next.type) qs.set("type", next.type);
    const q = qs.toString();
    return q ? `/transactions?${q}` : "/transactions";
  };

  return (
    <>
      <PageTitle
        title="Transactions"
        subtitle="Every roster move the league has made, newest first. Commissioner actions are public here too."
      />
      <div className="mb-4 space-y-2">
        <FilterLinks
          label="Type"
          current={type}
          options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
          hrefFor={(value) => hrefWith({ team: teamSlug, type: value })}
        />
        <FilterLinks
          label="Team"
          current={team?.slug}
          options={teamRows.map((t) => ({ value: t.slug, label: t.name ?? t.slug }))}
          hrefFor={(value) => hrefWith({ team: value, type })}
        />
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty>
            {teamSlug || type ? "No transactions match this filter." : "No transactions yet."}
          </Empty>
        ) : (
          <Table head={["When", "Type", "Team", "What happened"]}>
            {rows.map((t) => (
              <Row key={t.id}>
                <Cell>
                  <span className="whitespace-nowrap text-xs text-muted">{when(t.createdAt)}</span>
                  {t.week !== null ? <div className="text-xs text-muted">week {t.week}</div> : null}
                </Cell>
                <Cell>
                  <Badge tone={t.type === "commissioner" ? "warn" : "neutral"}>{TYPE_LABEL[t.type]}</Badge>
                </Cell>
                <Cell>
                  <div className="space-y-0.5">
                    {t.teamIds.length === 0 ? (
                      <span className="text-muted">league</span>
                    ) : (
                      t.teamIds.map((id) => (
                        <div key={id}>
                          <TeamLabel slug={teamById.get(id)?.slug} name={teamById.get(id)?.name ?? null} />
                        </div>
                      ))
                    )}
                  </div>
                </Cell>
                <Cell>{describe(t.type, t.payload, ctx)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
      {rows.length === LIMIT ? (
        <p className="mt-3 text-xs text-muted">Showing the {LIMIT} most recent transactions.</p>
      ) : null}
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page — transactions simply
 * renders empty instead.
 */
export default async function TransactionsPage(props: Parameters<typeof TransactionsPageInner>[0]) {
  try {
    return await TransactionsPageInner(props);
  } catch (error) {
    console.error("[transactions] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="Transactions" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
