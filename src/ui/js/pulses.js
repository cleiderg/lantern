// Lantern UI: the Pulses view.

import {
  back,
  badge,
  el,
  load,
  pageOf,
  pager,
  panel,
  table,
  ticketLink,
  usd,
  VIEWS,
  when,
} from './core.js';
import { childOutcome } from './sessions.js';

// ── Pulses ────────────────────────────────────────────────────────────────────

VIEWS.pulses = async (args) => {
  if (args[0]) return pulseDetail(args[0]);
  const list = pageOf(await load('pulses'));
  const rows = list.rows;
  return el(
    'section',
    {},
    el('p', { class: 'muted' }, 'Last 24 hours.'),
    panel('Pulses', () =>
      table(
        ['#', 'Status', 'Started', 'Cost', 'Findings'],
        rows.map((p) => [
          el('a', { href: `#pulses/${p.id}` }, `#${p.id}`),
          badge(p.status),
          when(p.started_at),
          usd(p.cost_usd),
          p.findings.length
            ? el(
                'span',
                { class: 'actions' },
                p.findings.map((f) => badge(`${f.action_key}: ${f.outcome}`)),
              )
            : el('span', { class: 'muted' }, 'none'),
        ]),
        'No pulses in the last 24h.',
      ),
    ),
    pager(list),
  );
};

async function pulseDetail(id) {
  const { pulse: p, findings, sessions } = await load('pulses', [id]);
  return el(
    'section',
    {},
    back('#pulses', 'Pulses'),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('strong', {}, `Pulse #${p.id}`),
        badge(p.status),
        el('span', { class: 'spacer' }),
        el('a', { href: `#transcript/pulse/${p.id}` }, 'Orchestrator transcript →'),
      ),
      el(
        'dl',
        { class: 'meta' },
        el('dt', {}, 'Window'),
        el('dd', {}, `${p.window_start} → ${p.window_end}`),
        el('dt', {}, 'Cost'),
        el('dd', {}, usd(p.cost_usd)),
        p.duration_ms
          ? [el('dt', {}, 'Duration'), el('dd', {}, `${Math.round(p.duration_ms / 1000)}s`)]
          : null,
      ),
      p.summary ? el('pre', {}, p.summary) : null,
      p.error ? el('p', { class: 'warn' }, p.error) : null,
    ),
    el('h3', {}, 'Findings'),
    panel('Pulse findings', () =>
      table(
        ['Action', 'Outcome', 'Ticket', 'Detail'],
        findings.map((f) => [
          f.action_key,
          badge(f.outcome),
          f.ticket_id ? ticketLink(f.ticket_id) : '',
          f.detail || '',
        ]),
        'No findings.',
      ),
    ),
    el('h3', {}, 'Sessions'),
    panel('Pulse sessions', () =>
      table(
        ['Session', 'Status', 'Tier', 'Result', ''],
        sessions.map((s) => [
          el('code', {}, s.id.slice(0, 8)),
          badge(s.status),
          badge(s.tier),
          s.structured ? childOutcome(s.structured) : s.result ? el('pre', {}, s.result) : '',
          s.transcript_path
            ? el('a', { href: `#transcript/session/${encodeURIComponent(s.id)}` }, 'Transcript')
            : '',
        ]),
        'No child sessions.',
      ),
    ),
  );
}
