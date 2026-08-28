/**
 * Matching FantasyPros players to Sleeper players (SPEC Appendix B).
 *
 * Order: yahoo_id, then espn_id, then normalized name + position (preferring
 * the same NFL team). Team defenses map by abbreviation through the team map.
 * Every match is stored in `fp_player_map` with how it was made; a match made
 * by name is re-checked when a later pull supplies an id.
 */
import { nflverseToSleeper } from "./teamAbbrev.ts";

export type MatchedBy = "yahoo_id" | "espn_id" | "name" | "manual";

/** Suffixes stripped before comparing names (Appendix B). */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Lower-case, strip accents and punctuation, drop generational suffixes,
 * collapse whitespace. "Marvin Harrison Jr." → "marvin harrison".
 */
export function normalizeName(name: string): string {
  const stripped = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/[.'`’]/g, "") // punctuation that varies between feeds
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = stripped.split(" ").filter((p) => !SUFFIXES.has(p.replace(/-/g, "")));
  return parts.join(" ").trim();
}

export interface SleeperCandidate {
  playerId: string;
  fullName: string;
  position: string | null;
  nflTeam: string | null;
  yahooId: string | null;
  espnId: string | null;
}

export interface FpPlayer {
  fpPlayerId: string;
  name: string;
  position: string | null;
  team: string | null;
  yahooId?: string | null;
  espnId?: string | null;
}

export interface MatchIndex {
  byYahoo: Map<string, SleeperCandidate>;
  byEspn: Map<string, SleeperCandidate>;
  /** normalized name + "|" + position → candidates */
  byNamePos: Map<string, SleeperCandidate[]>;
  /** team abbreviation → the DEF player (Sleeper uses the abbreviation as the id) */
  byDefTeam: Map<string, SleeperCandidate>;
}

export function buildMatchIndex(candidates: SleeperCandidate[]): MatchIndex {
  const byYahoo = new Map<string, SleeperCandidate>();
  const byEspn = new Map<string, SleeperCandidate>();
  const byNamePos = new Map<string, SleeperCandidate[]>();
  const byDefTeam = new Map<string, SleeperCandidate>();
  for (const c of candidates) {
    if (c.yahooId) byYahoo.set(String(c.yahooId), c);
    if (c.espnId) byEspn.set(String(c.espnId), c);
    if (c.position === "DEF") {
      // A Sleeper team defense has the team abbreviation as its player_id.
      byDefTeam.set(c.playerId.toUpperCase(), c);
      if (c.nflTeam) byDefTeam.set(c.nflTeam.toUpperCase(), c);
    }
    const key = `${normalizeName(c.fullName)}|${c.position ?? ""}`;
    const list = byNamePos.get(key);
    if (list) list.push(c);
    else byNamePos.set(key, [c]);
  }
  return { byYahoo, byEspn, byNamePos, byDefTeam };
}

export interface MatchResult {
  playerId: string;
  matchedBy: MatchedBy;
}

/** FantasyPros position → Sleeper position. FP uses DST; Sleeper uses DEF. */
export function fpPositionToSleeper(position: string | null): string | null {
  if (!position) return null;
  const p = position.toUpperCase();
  if (p === "DST" || p === "DEF" || p === "D/ST") return "DEF";
  return p;
}

/**
 * Match one FantasyPros player. Returns null when nothing matches — the caller
 * writes those to `rankings_unmatched` for the admin mapping control.
 */
export function matchFpPlayer(fp: FpPlayer, index: MatchIndex): MatchResult | null {
  if (fp.yahooId) {
    const hit = index.byYahoo.get(String(fp.yahooId));
    if (hit) return { playerId: hit.playerId, matchedBy: "yahoo_id" };
  }
  if (fp.espnId) {
    const hit = index.byEspn.get(String(fp.espnId));
    if (hit) return { playerId: hit.playerId, matchedBy: "espn_id" };
  }

  const position = fpPositionToSleeper(fp.position);

  // Team defenses: FP gives the team abbreviation, not a person's name.
  if (position === "DEF") {
    const team = (fp.team ?? "").toUpperCase();
    // Accept either alphabet: FantasyPros mostly uses Sleeper's codes, but a
    // feed carrying nflverse's "LA" must still resolve to Sleeper's "LAR".
    const hit = index.byDefTeam.get(team) ?? index.byDefTeam.get(nflverseToSleeper(team).toUpperCase());
    if (hit) return { playerId: hit.playerId, matchedBy: "name" };
    return null;
  }

  const key = `${normalizeName(fp.name)}|${position ?? ""}`;
  const candidates = index.byNamePos.get(key);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return { playerId: candidates[0]!.playerId, matchedBy: "name" };

  // Several players share a name and position — prefer the same NFL team.
  if (fp.team) {
    const team = fp.team.toUpperCase();
    const sameTeam = candidates.filter((c) => (c.nflTeam ?? "").toUpperCase() === team);
    if (sameTeam.length === 1) return { playerId: sameTeam[0]!.playerId, matchedBy: "name" };
  }
  // Ambiguous: leave it for the admin mapping control rather than guess.
  return null;
}
