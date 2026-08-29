import { sql } from "drizzle-orm";

/**
 * A timestamp parameter for a **raw** `sql` template.
 *
 * Drizzle serializes values correctly when it knows the column's type — every
 * `eq(table.someTimestamp, date)` is fine. A raw `sql` template has no such
 * type information, so the value goes to the driver untyped, and the two
 * drivers this project runs on disagree about what to do with a `Date`:
 *
 *  - **PGlite** (tests) accepts it.
 *  - **postgres-js** (production) throws
 *    `ERR_INVALID_ARG_TYPE: The "string" argument must be of type string ...
 *    Received an instance of Date`.
 *
 * So a raw template holding a `Date` passes the entire test suite and then
 * fails on every request in production. It did: the scheduler tick's job-claim
 * query and `updateRollups`' day window were both written this way, and the
 * tick answered 500 once a minute the moment it was first able to authenticate.
 *
 * Passing the ISO string with an explicit cast is unambiguous for both drivers.
 * Use this for every timestamp inside a raw `sql` template.
 */
export function tstz(value: Date) {
  return sql`${value.toISOString()}::timestamptz`;
}
