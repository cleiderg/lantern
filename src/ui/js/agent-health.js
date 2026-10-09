// Lantern UI: per-agent health — countdown, spend chart, controls, and the
// agent page.

import {
  act,
  ago,
  back,
  el,
  load,
  panel,
  parseTs,
  table,
  tile,
  toast,
  usd,
  VIEWS,
  when,
} from './core.js';
import { fmtDuration } from './format.js';
import { changesCard, fileOnlyCard, settingsCard } from './settings.js';

// ── agent health ────────────────────────────────────────────────────────

/** A gate refusal in plain words, with what to do about it. */
export function skipNote(k) {
  return el(
    'div',
    { class: 'skip-note' },
    el('strong', {}, 'Skipped: '),
    k.plain,
    k.fix ? el('div', { class: 'muted' }, `Fix: ${k.fix}`) : null,
    el('div', { class: 'muted' }, `pulse #${k.pulseId} · ${ago(k.at)}`),
  );
}

/** "in 4m 10s", ticking every second without a refresh (see tickCountdowns). */
export function countdown(a, short = false) {
  const at = a.state === 'running' && a.running ? a.next_pulse_at : null;
  const node = el('span', { class: 'countdown' }, at ? '' : short ? '—' : '— (daemon not running)');
  if (at) {
    node.setAttribute('data-countdown', at);
    tickCountdown(node);
  }
  return node;
}

export function tickCountdown(node) {
  const t = parseTs(node.getAttribute('data-countdown'));
  const s = t === null ? Number.NaN : Math.round((t - Date.now()) / 1000);
  if (Number.isNaN(s)) node.textContent = '—';
  else if (s <= 0) node.textContent = 'due now';
  else {
    const m = Math.floor(s / 60);
    node.textContent = m ? `in ${m}m ${String(s % 60).padStart(2, '0')}s` : `in ${s}s`;
  }
}

export function spendLine(sp) {
  if (!sp) return '—';
  const pct = sp.ceilingUsd ? Math.round((sp.spentUsd / sp.ceilingUsd) * 100) : 0;
  const trip = sp.tripped
    ? ' · ceiling reached'
    : sp.tripAt
      ? ` · trips ~${new Date(sp.tripAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
  return `${usd(sp.spentUsd)} of ${usd(sp.ceilingUsd)} (${pct}%)${trip}`;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Cumulative spend today (UTC hours) against the ceiling, with the recent
 * rate projected forward as a dashed line. Inline SVG, no chart library.
 */
export function spendChart(sp, big = false) {
  if (!sp) return null;
  if (!(sp.spentUsd > 0)) {
    return big ? el('p', { class: 'muted' }, 'No spend recorded yet today (UTC).') : null;
  }
  const W = big ? 480 : 240;
  const H = big ? 96 : 44;
  const pad = 3;
  const hourNow = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  const max = Math.max(sp.ceilingUsd, sp.spentUsd) || 1;
  const x = (h) => pad + (h / 24) * (W - 2 * pad);
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const pts = [[0, 0]];
  let cum = 0;
  sp.series.forEach((v, h) => {
    if (h > hourNow) return;
    cum += v;
    pts.push([Math.min(h + 1, hourNow), cum]);
  });
  const root = svg('svg', {
    class: `spark${big ? ' spark-big' : ''}${sp.tripped ? ' tripped' : ''}`,
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Spend today ${usd(sp.spentUsd)} of ${usd(sp.ceilingUsd)} ceiling`,
  });
  root.append(
    svg('line', {
      class: 'spark-ceiling',
      x1: pad,
      x2: W - pad,
      y1: y(sp.ceilingUsd),
      y2: y(sp.ceilingUsd),
    }),
    svg('polyline', {
      class: 'spark-line',
      points: pts.map(([h, v]) => `${x(h).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    }),
  );
  if (!sp.tripped && sp.ratePerHour > 0) {
    const endH = sp.tripAt ? hourNow + (parseTs(sp.tripAt) - Date.now()) / 3_600_000 : 24;
    const endV = Math.min(sp.ceilingUsd, sp.spentUsd + sp.ratePerHour * (endH - hourNow));
    root.append(
      svg('line', {
        class: 'spark-proj',
        x1: x(hourNow),
        y1: y(sp.spentUsd),
        x2: x(Math.min(24, endH)),
        y2: y(endV),
      }),
    );
  }
  const title = svg('title', {});
  title.textContent = `${spendLine(sp)} · ${usd(sp.ratePerHour)}/h over the last 3h`;
  root.append(title);
  return el('div', { class: 'spark-wrap' }, root);
}

VIEWS.agents = async ([id]) => {
  const {
    agent: a,
    skips,
    spend,
    findings24h,
    config,
    editable,
    configChanges,
  } = await load('agents', [id]);
  return el(
    'section',
    {},
    back('#status', 'Overview'),
    el(
      'div',
      { class: 'grid tiles' },
      tile(
        'Next pulse',
        countdown(a, true),
        a.running ? `every ${fmtDuration(a.heartbeat_seconds)}` : 'daemon not running',
      ),
      tile('Spend today', usd(spend.spentUsd), `of ${usd(spend.ceilingUsd)} ceiling`, {
        alert: spend.tripped,
      }),
      tile(
        'Burn rate',
        `${usd(spend.ratePerHour)}/h`,
        spend.tripped
          ? 'ceiling reached'
          : spend.tripAt
            ? `trips ~${new Date(spend.tripAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'no trip before UTC midnight',
      ),
      tile('Skips (24h)', String(skips.length), a.lastSkip ? 'latest pulse was skipped' : null, {
        alert: !!a.lastSkip,
      }),
    ),
    panel('Burn chart', () =>
      el('div', { class: 'card' }, el('h3', {}, 'Burn today (UTC)'), spendChart(spend, true)),
    ),
    el('h2', {}, 'Gate refusals, last 24 h'),
    panel('Gate refusals', () =>
      table(
        ['When', 'Pulse', 'What happened', 'Fix'],
        skips.map((k) => [
          when(k.at),
          el('a', { href: `#pulses/${k.pulseId}` }, `#${k.pulseId}`),
          el('div', {}, k.plain, el('div', { class: 'muted' }, k.reason)),
          k.fix || '—',
        ]),
        'No gate refusals in the last 24 h.',
      ),
    ),
    el('h2', {}, 'Findings per action, last 24 h'),
    panel('Findings per action', () =>
      table(
        ['Action', 'Clean', 'Finding', 'Skipped', 'Error'],
        findings24h.map((f) => [
          el('code', {}, f.action_key),
          String(f.clean),
          String(f.finding),
          String(f.skipped),
          String(f.error),
        ]),
        'No findings recorded in the last 24 h.',
      ),
    ),
    el('h2', {}, 'Settings'),
    config
      ? [
          panel('Settings', () => settingsCard(a, config, editable)),
          panel('Change history', () => changesCard(configChanges)),
          panel('File-only settings', () => fileOnlyCard(config)),
        ]
      : a.configError
        ? el('p', { class: 'warn' }, `Config: ${a.configError}`)
        : el('p', { class: 'muted' }, 'No .agent.md — this agent runs on the built-in defaults.'),
  );
};

export function agentControls(a) {
  const id = encodeURIComponent(a.id);
  const tripped = a.state === 'tripped';
  return el(
    'div',
    { class: 'actions' },
    a.running
      ? el(
          'button',
          {
            class: 'danger',
            onclick: () =>
              act(`agents/${id}/stop`, {}, `Stop ${a.display_name}'s daemon (pid ${a.pid})?`),
          },
          'Stop',
        )
      : el(
          'button',
          {
            class: 'primary',
            onclick: () =>
              act(
                `agents/${id}/start`,
                {},
                `Start ${a.display_name}? Each pulse is a real Claude turn and costs money.`,
              ),
            disabled: tripped,
            title: tripped ? 'Tripped by the budget: Resume first' : null,
          },
          'Start',
        ),
    el(
      'button',
      {
        onclick: () =>
          act(
            `agents/${id}/pulse`,
            {},
            `Run one pulse for ${a.display_name} now? It is a real Claude turn.`,
          ),
        disabled: tripped,
      },
      'Pulse now',
    ),
  );
}

export function registerCard() {
  const path = el('input', {
    type: 'text',
    class: 'grow',
    placeholder: '/absolute/path/to/agent.agent.md',
    'aria-label': 'Agent config path',
  });
  return el(
    'div',
    { class: 'card', 'data-key': 'register' },
    el('div', { class: 'card-title' }, 'Register or refresh an agent'),
    el(
      'p',
      { class: 'muted' },
      'Reads an .agent.md and creates or updates its agent. The same as `lantern agent add`.',
    ),
    el(
      'div',
      { class: 'actions' },
      path,
      el(
        'button',
        {
          class: 'primary',
          onclick: () =>
            path.value.trim()
              ? act('agents/register', { path: path.value })
              : toast('Enter the absolute path to an .agent.md', 'error'),
        },
        'Register',
      ),
    ),
  );
}
