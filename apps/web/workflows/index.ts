/**
 * Workflow definitions (SPEC §4.1, §9.2).
 *
 * Why these exist: a serverless function is capped at 800 s on Pro, but the
 * draft runs 1.5–4 hours and an agent session can run for many minutes. A
 * workflow's steps are durable and survive across invocations, so the long
 * jobs live here while the short ones stay inline in the per-minute tick.
 *
 * The `'use workflow'` directive marks a durable function; `'use step'` marks
 * one durable step inside it.
 */
export { agentSessionWorkflow } from "./agentSession";
export { draftWorkflow } from "./draft";
export { waiverRunWorkflow } from "./waivers";
export { ingestWorkflow } from "./ingest";
export { finalizeWeekWorkflow } from "./finalizeWeek";
export { weekPlanWorkflow } from "./weekPlan";
export { reporterWorkflow } from "./reporter";
