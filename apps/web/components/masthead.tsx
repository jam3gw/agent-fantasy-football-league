/**
 * The broadcast masthead: who is playing, whether anything is live, a ticker
 * of this week's scores, and the six-link bar.
 *
 * It reads the league's live state itself rather than taking it from each
 * page, so every route carries the same banner. It exports no `revalidate` of
 * its own — a layout that did would pin the whole tree to one freshness
 * window, and §12.1 wants 30 s on the live pages and 5 min on the rest.
 */
import Link from "next/link";
import { LiveDot, Container, formatEtTime } from "./broadcast";
import { PrimaryNav } from "./nav";
import { allTeams, liveStatus, safeRead as safe, settings, weekMatchups } from "@/lib/queries";

interface TickerGame {
  id: number;
  away: string;
  home: string;
  awayPoints: number;
  homePoints: number;
  final: boolean;
}

function TickerItem({ game, hidden }: { game: TickerGame; hidden?: boolean }) {
  const awayLeads = game.awayPoints > game.homePoints;
  const homeLeads = game.homePoints > game.awayPoints;
  return (
    <div
      aria-hidden={hidden ? "true" : undefined}
      data-ticker-echo={hidden ? "" : undefined}
      className="flex items-baseline gap-[9px] whitespace-nowrap border-r border-band-border px-5"
    >
      <span className="text-[13px] font-semibold text-band-text">{game.away}</span>
      <span
        className={`text-[15px] font-bold tabular-nums ${awayLeads ? "text-accent-bright" : "text-band-text"}`}
      >
        {game.awayPoints.toFixed(2)}
      </span>
      <span className="text-[12px] text-band-faint">·</span>
      <span className="text-[13px] font-semibold text-band-text">{game.home}</span>
      <span
        className={`text-[15px] font-bold tabular-nums ${homeLeads ? "text-accent-bright" : "text-band-text"}`}
      >
        {game.homePoints.toFixed(2)}
      </span>
      <span
        className={`text-[10px] font-bold uppercase tracking-[0.1em] ${
          game.final ? "text-band-faint" : "text-accent-bright"
        }`}
      >
        {game.final ? "final" : "live"}
      </span>
    </div>
  );
}

export async function Masthead() {
  const league = await safe(settings, null);
  const season = league?.season ?? null;
  const week = league?.currentWeek ?? 1;

  const [teams, weekly, live] = await Promise.all([
    safe(allTeams, []),
    safe(() => weekMatchups(week), []),
    safe(() => liveStatus(), { liveGames: 0, lastUpdateAt: null, delayed: false }),
  ]);
  const nameOf = new Map(teams.map((t) => [t.id, t.name ?? t.modelLabel ?? t.slug]));

  const games: TickerGame[] = weekly.map((m) => ({
    id: m.id,
    away: nameOf.get(m.awayTeamId) ?? "away",
    home: nameOf.get(m.homeTeamId) ?? "home",
    awayPoints: m.awayPoints ?? 0,
    homePoints: m.homePoints ?? 0,
    final: m.final,
  }));

  return (
    <header className="bg-band text-band-text">
      <Container>
        <div className="flex min-h-[60px] flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2 sm:flex-nowrap">
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
            <Link href="/" className="text-[21px] font-extrabold tracking-[-0.03em] text-band-text">
              Agent Fantasy Football
            </Link>
            <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-band-muted">
              {season ? `${season} · week ${week}` : "not set up yet"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {live.liveGames > 0 ? (
              <div className="flex items-center gap-2 rounded-full bg-[rgba(122,184,111,0.14)] px-[11px] py-[5px]">
                <LiveDot className="bg-accent-bright" />
                <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-bright">
                  {live.liveGames} game{live.liveGames === 1 ? "" : "s"} live
                </span>
              </div>
            ) : null}
            <span className="text-[13px] text-band-muted">
              {live.delayed
                ? "Live scores delayed — showing the last we received"
                : live.lastUpdateAt
                  ? `Updated ${formatEtTime(live.lastUpdateAt)}`
                  : "No scores yet"}
            </span>
          </div>
        </div>
      </Container>

      {games.length > 0 ? (
        <div className="flex h-[42px] items-center overflow-hidden border-y border-band-border">
          <div className="flex flex-shrink-0 items-center self-stretch bg-accent px-4 text-[11px] font-bold uppercase tracking-[0.14em] text-band-text">
            {live.liveGames > 0 ? "Live" : `Week ${week}`}
          </div>
          <div
            className="ticker-viewport flex-1 overflow-hidden"
            tabIndex={0}
            role="group"
            aria-label={`Week ${week} scores`}
          >
            {/* The week's games twice over, so translating the track by half
                its width loops without a seam. The copy is hidden from
                assistive tech so the scores are announced once. */}
            <div className="ticker-track">
              {games.map((g) => (
                <TickerItem key={g.id} game={g} />
              ))}
              {games.map((g) => (
                <TickerItem key={`echo-${g.id}`} game={g} hidden />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <Container>
        <PrimaryNav currentWeek={week} />
      </Container>
    </header>
  );
}
