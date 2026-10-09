// Lantern UI: the Overview. Agent health is agent-health.js; its settings
// form, settings.js.

import {
  agentControls,
  countdown,
  registerCard,
  skipNote,
  spendChart,
  spendLine,
} from './agent-health.js';
import { badge, el, lastStatus, load, minCeiling, panel, tile, usd, VIEWS, when } from './core.js';
import { fmtDuration } from './format.js';

// ── Overview ──────────────────────────────────────────────────────────────────

VIEWS.status = async () => {
  // The chrome's status and the metrics in one request.
  const metrics = await load('metrics');
  const s = lastStatus;
  const ceiling = minCeiling(s);
  const meter = ceiling
    ? el('meter', {
        min: 0,
        max: ceiling,
        low: ceiling * 0.6,
        high: ceiling * 0.85,
        optimum: 0,
        value: Math.min(s.spend.cost_usd, ceiling),
        'aria-label': 'Spend against the lowest daily ceiling',
      })
    : null;
  return el(
    'section',
    {},
    el(
      'div',
      { class: 'grid tiles' },
      tile('Spend today', usd(s.spend.cost_usd), ceiling ? `of ${usd(ceiling)} ceiling` : null, {
        meter,
        alert: ceiling !== null && s.spend.cost_usd >= ceiling,
      }),
      tile('Pulses today', String(s.spend.pulses), `${s.spend.sessions} child session(s)`),
      tile('Live children', String(s.liveSessions), `${s.queuedSessions} queued`, {
        href: '#sessions',
      }),
      tile('To answer', String(s.unanswered), 'escalations', {
        href: '#inbox',
        alert: s.unanswered > 0,
      }),
      tile('Needs triage', String(s.needsTriage), 'tickets', { href: '#triage' }),
    ),
    el('h2', {}, 'Agents'),
    s.agents.length
      ? el(
          'div',
          { class: 'grid agents' },
          s.agents.map((a) => panel(`Agent ${a.id}`, () => agentCard(a))),
        )
      : el('div', { class: 'empty' }, 'No agents yet — register one below.'),
    panel('Last 30 days', () => metricsCard(metrics)),
    panel('Register an agent', registerCard),
  );
};

/** The six metrics: whether the loop is actually working. */
function metricsCard(m) {
  // Rows come worded from /api/metrics — the same text `lantern metrics` prints.
  const row = (r) =>
    el(
      'div',
      { class: 'metric' },
      el('dt', {}, r.label),
      el('dd', {}, r.value, r.detail ? el('div', { class: 'muted' }, r.detail) : null),
    );
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, `Last ${m.days} days`),
    el('dl', { class: 'metrics' }, ...m.rows.map(row)),
  );
}

function agentCard(a) {
  return el(
    'div',
    { class: 'card', 'data-agent': a.id, 'data-key': `agent-${a.id}` },
    el(
      'div',
      { class: 'card-head' },
      el('span', {
        class: `dot${a.running ? ' on' : ''}`,
        title: a.running ? `daemon pid ${a.pid}` : 'daemon not running',
      }),
      el('span', { class: 'card-title' }, a.display_name),
      el('span', { class: 'muted' }, a.id),
      el('span', { class: 'spacer' }),
      badge(a.state),
    ),
    a.deadman.stale
      ? el(
          'p',
          { class: 'warn' },
          `No pulse for ${Math.round(a.deadman.staleSeconds / 60)}m — is the daemon down?`,
        )
      : null,
    a.configError ? el('p', { class: 'warn' }, `Config: ${a.configError}`) : null,
    a.paused_reason ? el('p', { class: 'muted' }, a.paused_reason) : null,
    a.lastSkip ? skipNote(a.lastSkip) : null,
    el(
      'dl',
      { class: 'meta' },
      el('dt', {}, 'Next pulse'),
      el('dd', {}, countdown(a)),
      el('dt', {}, 'Daemon'),
      el('dd', {}, a.running ? `running · pid ${a.pid}` : 'not running'),
      el('dt', {}, 'Heartbeat'),
      el('dd', {}, `every ${fmtDuration(a.heartbeat_seconds)}`),
      el('dt', {}, 'Last pulse'),
      el('dd', {}, when(a.last_pulse_at)),
      el('dt', {}, 'Ceiling'),
      el('dd', {}, a.dailyCeilingUsd === null ? '—' : `${usd(a.dailyCeilingUsd)} / day`),
      el('dt', {}, 'Burn today'),
      el('dd', {}, spendLine(a.spend)),
      el('dt', {}, 'Children'),
      el('dd', {}, `${a.liveSessions} live, max ${a.max_children}`),
      el('dt', {}, 'Workdir'),
      el('dd', {}, el('code', { class: 'truncate', title: a.workdir }, el('span', {}, a.workdir))),
    ),
    spendChart(a.spend),
    agentControls(a),
    el(
      'a',
      { class: 'card-link', href: `#agents/${encodeURIComponent(a.id)}` },
      'Health details →',
    ),
  );
}
