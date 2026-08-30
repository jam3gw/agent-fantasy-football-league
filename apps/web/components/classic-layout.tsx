/**
 * The page shell the site had before the redesign: one centred column with a
 * max width.
 *
 * The root `<main>` is now unconstrained, because the redesigned pages run
 * full-bleed bands — the masthead, the leaderboard, the matchup hero — that a
 * container would cut short. The pages the redesign does not cover still want
 * the old column, so each of their route segments re-exports this as its
 * layout. That keeps them rendering exactly as they did without moving any
 * files or rewriting their imports.
 */
import type { ReactNode } from "react";

export function ClassicLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6">{children}</div>;
}
