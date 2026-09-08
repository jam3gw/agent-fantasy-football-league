"use client";
/**
 * A countdown that keeps counting in an open tab. The server renders the
 * value for its own clock and the page's freshness stamp carries no clock,
 * so without this a viewer could watch "in 12m" sit for an hour. The first
 * render repeats the server's text so hydration matches; the tick starts
 * after mount and runs every half minute, the resolution of the text. Once
 * the instant has passed the text is `past`, the word the server would use
 * for the same state, so an open tab and a fresh render agree.
 */
import { useEffect, useState } from "react";
import { countdown } from "@/lib/countdown";

export function Countdown({ to, initial, past = "now" }: { to: string; initial: string; past?: string }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const target = new Date(to);
    const tick = () => {
      const c = countdown(new Date(), target);
      setText(c === "now" ? past : c);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [to, past]);
  return <>{text}</>;
}
