/**
 * Lantern's budget constants — a leaf module, so config, gates, the digest and
 * the store can all import them without a cycle (they lived in
 * store/usage.ts, which agent-config.ts imported, which imports agent.ts).
 */

/**
 * Default daily ceiling. One spelling, imported by the gate, the digest and
 * `lantern status` — it used to be a literal 15.0 in three places, which is how
 * a ceiling drifts apart from the number that enforces it.
 */
export const DEFAULT_DAILY_CEILING_USD = 15.0;

/**
 * Per-session cost ceiling ($1.50 by default), passed to `--max-budget-usd` for
 * the orchestrator turn and every child, and reserved per started child
 * against the daily budget. One spelling, for the same reason as the above.
 */
export const PER_SESSION_CEILING_USD = 1.5;
