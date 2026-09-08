"use client";
/**
 * A countdown that keeps counting in an open tab. The server renders the
 * value for its own clock and the page's freshness stamp carries no clock,
 * so without this a viewer could watch "in 12m" sit for an hour. The first
 * render repeats the server's text so hydration matches; the tick starts
 * after mount and runs every half minute, the resolution of the text.
 */
import { useEffect, useState } from "react";
import { countdown } from "@/lib/countdown";

export function Countdown({ to, initial }: { to: string; initial: string }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const target = new Date(to);
    const tick = () => setText(countdown(new Date(), target));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [to]);
  return <>{text}</>;
}
