/**
 * All code reads time through a Clock (SPEC §4.3). In production the clock is
 * the system clock; in simulation the engine wraps this with a clock that
 * reads the `clock_override` row. Pure code takes a Clock so tests can pin time.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Fixed, manually advanceable clock for tests and simulation. */
export class FixedClock implements Clock {
  private at: Date;
  constructor(at: Date | string) {
    this.at = typeof at === "string" ? new Date(at) : at;
  }
  now(): Date {
    return new Date(this.at.getTime());
  }
  set(at: Date | string): void {
    this.at = typeof at === "string" ? new Date(at) : at;
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}
