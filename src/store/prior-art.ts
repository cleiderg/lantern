import type { Db } from '../db.ts';
import type { EventContext, TicketStatus } from '../types.ts';
import { TERMINAL_SQL } from '../types.ts';
import { createLink } from './links.ts';

export type PriorArtResult = {
  id: number;
  title: string;
  status: TicketStatus;
  resolution: string | null;
  score: number; // boosted BM25 — more negative = more relevant
};

/**
 * Build a safe FTS5 MATCH expression from free text.
 * Splits on anything that is not a word character, then quotes each word, so FTS5
 * special characters (AND/OR/NOT/-/*) are treated as literals. Words under 3 chars are dropped — they carry no signal
 * and FTS5 often strips them anyway via the porter tokeniser.
 */
export function buildFtsQuery(text: string): string {
  return (
    text
      // Split on punctuation too, as the FTS tokenizer does: stripping it glued
      // `Servlet.service()` into `Servletservice`, which matches nothing.
      .split(/[^\w]+/)
      .filter((w) => w.length >= 3)
      .map((w) => `"${w}"`)
      .join(' ')
  );
}

/**
 * Score threshold below which we auto-write a `relates_to` link.
 * BM25 values are negative; this corresponds to a reasonably strong match.
 * Calibrated loosely — the eval harness will tighten it.
 */
const AUTO_LINK_THRESHOLD = -1.5;

export type PriorArtOptions = {
  limit?: number;
  /**
   * If set, auto-write `relates_to` links from this ticket to any result
   * whose boosted score clears `linkThreshold`.
   * Must be an orchestrator call — children don't write links.
   */
  fromTicketId?: number;
  ctx?: EventContext;
  /**
   * Boosted BM25 score that triggers an auto-link (default: AUTO_LINK_THRESHOLD).
   * Lower (more negative) = stricter. Override in tests where corpus is tiny.
   */
  linkThreshold?: number;
};

/**
 * Return the top-N prior tickets most relevant to the given title+body.
 *
 * Ranking (more negative = more relevant):
 *   BM25 over (title, body, resolution)
 *   × 2 for closed/wontfix/duplicate tickets with a resolution
 *   − file_overlap_count  (shared paths in ticket_files)
 *   − 2.0 for exact fingerprint match
 *
 * File-overlap uses json_each() so the path list can be arbitrary length without
 * building a dynamic IN clause.
 */
export function priorArt(
  db: Db,
  input: { title: string; body?: string; files?: string[]; fingerprint?: string | null },
  opts: PriorArtOptions = {},
): PriorArtResult[] {
  const { limit = 5, fromTicketId, ctx, linkThreshold = AUTO_LINK_THRESHOLD } = opts;
  const files = input.files ?? [];
  const fingerprint = input.fingerprint ?? null;

  const ftsQuery = buildFtsQuery([input.title, input.body ?? ''].join(' '));
  if (!ftsQuery) return [];

  const filesJson = JSON.stringify(files);

  let rows: PriorArtResult[];
  try {
    rows = db
      .prepare(
        `
        SELECT
          t.id,
          t.title,
          t.status,
          t.resolution,
          bm25(tickets_fts) * CASE
            WHEN t.status IN ${TERMINAL_SQL}
                 AND t.resolution IS NOT NULL
                 AND t.resolution != ''
            THEN 2.0
            ELSE 1.0
          END
          - (
            SELECT CAST(COUNT(*) AS REAL)
            FROM ticket_files tf
            WHERE tf.ticket_id = t.id
              AND tf.path IN (SELECT value FROM json_each(?))
          )
          - CASE WHEN ? IS NOT NULL AND t.fingerprint = ? THEN 2.0 ELSE 0.0 END
          AS score
        FROM tickets_fts
        JOIN tickets t ON tickets_fts.rowid = t.id
        WHERE tickets_fts MATCH ?
          AND (? IS NULL OR t.id != ?)
        ORDER BY score ASC
        LIMIT ?
      `,
      )
      .all(
        filesJson,
        fingerprint,
        fingerprint,
        ftsQuery,
        fromTicketId ?? null,
        fromTicketId ?? null,
        limit,
      ) as PriorArtResult[];
  } catch {
    // Malformed FTS query (edge case) — return nothing rather than crashing.
    return [];
  }

  // Auto-write relates_to links for strong matches when called by the orchestrator.
  if (fromTicketId !== undefined && ctx !== undefined) {
    for (const r of rows) {
      if (r.score <= linkThreshold) {
        createLink(db, { from_ticket: fromTicketId, to_ticket: r.id, rel: 'relates_to' });
      }
    }
  }

  return rows;
}
